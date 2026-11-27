begin;
alter table public.facilities
 add column if not exists booking_enabled boolean not null default false,
 add column if not exists accepts_online boolean not null default true,
 add column if not exists advance_booking_days integer not null default 7 check(advance_booking_days between 0 and 90),
 add column if not exists is_demo boolean not null default false,
 add column if not exists website text,
 add column if not exists external_place_id text;
alter table public.doctors add column if not exists available_for_booking boolean not null default true;
alter table public.patient_profiles add column if not exists mobile text check(mobile is null or mobile ~ '^[+][1-9][0-9]{9,14}$');
alter table banr_private.onboarding_requests add column if not exists claim_facility_id text references public.facilities(id);
create unique index if not exists onboarding_active_claim on banr_private.onboarding_requests(claim_facility_id)
 where claim_facility_id is not null and status not in ('Approved','Rejected');
create unique index if not exists facilities_external_place on public.facilities(external_place_id) where external_place_id is not null;
update public.facilities set external_place_id='google:0x3be7bf7256cf01ff:0x70d0e6bb66cd0a35' where id='elixir-clinic-mumbra' and external_place_id is null;
update public.facilities set is_demo=true where name like 'BANR Demo %';
update public.facilities f set booking_enabled=true
 where not f.is_demo and not f.directory_only and exists(select 1 from banr_private.provider_staff s where s.facility_id=f.id);
update public.facilities set directory_only=not booking_enabled where not is_demo;
create table banr_private.directory_audit (
 id bigint generated always as identity primary key, action text not null, subject text not null, at timestamptz not null default now()
);
alter table banr_private.directory_audit enable row level security;
revoke all on banr_private.directory_audit from public,anon,authenticated;
CREATE OR REPLACE FUNCTION banr_private.book_session(p_session uuid, p_name text, p_age integer, p_sex text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  patient uuid := auth.uid();
  verified_phone text;
  session_row public.opd_sessions%rowtype;
  booking_id uuid;
  new_token integer;
begin
  select case when phone_confirmed_at is not null then '+' || ltrim(phone, '+') end into verified_phone from auth.users where id = patient and (email_confirmed_at is not null or phone_confirmed_at is not null);
  if not found then raise exception 'Verify your account before booking.';
  end if;

  select * into session_row from public.opd_sessions where id = p_session for update;
  if not found then raise exception 'Session unavailable.'; end if;

  if not exists(select 1 from public.doctors d join public.facilities f on f.id=d.facility_id
    where d.id=session_row.doctor_id and f.booking_enabled and f.accepts_online
      and d.available_for_booking and not f.is_demo
      and session_row.starts_at < now()+make_interval(days=>f.advance_booking_days+1)
      and (session_row.starts_at at time zone 'Asia/Kolkata')::date <= (now() at time zone 'Asia/Kolkata')::date+f.advance_booking_days
      for share of f) then
    raise exception 'This facility is not accepting online appointments for this session.';
  end if;

  select id into booking_id from banr_private.appointments
  where session_id = p_session and (patient_id = patient or walkin_phone = verified_phone)
  order by token limit 1;
  if found then
    if exists(select 1 from banr_private.appointments where id=booking_id and status='cancelled') then
      raise exception 'This appointment was cancelled. Choose another session.';
    end if;
    return booking_id;
  end if;

  if session_row.ends_at <= now() or session_row.status = 'closed'
    or session_row.booked_count >= session_row.capacity then
    raise exception 'Session unavailable or full. Choose another session.';
  end if;

  insert into public.patient_profiles(user_id, name, age, sex)
  values (patient, trim(p_name), p_age, p_sex)
  on conflict (user_id) do update set name = excluded.name, age = excluded.age, sex = excluded.sex;

  update public.opd_sessions
    set last_token = last_token + 1, booked_count = booked_count + 1
    where id = p_session returning last_token into new_token;
  insert into banr_private.appointments(session_id, patient_id, token, source)
    values (p_session, patient, new_token, 'online') returning id into booking_id;
  return booking_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.banr_provider_action(p_session uuid, p_action text, p_expected_token integer, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s public.opd_sessions%rowtype;
  next_id uuid;
  next_token integer;
  phone_arg text;
  name_arg text;
  age_arg integer;
  sex_arg text;
  revised timestamptz;
  delay_minutes integer;
  ahead integer;
  pending integer;
  wait_minutes integer;
  walkin_result jsonb;
begin
  select ops.* into s from public.opd_sessions ops join public.doctors d on d.id=ops.doctor_id
  join banr_private.provider_staff staff on staff.facility_id=d.facility_id and staff.user_id=auth.uid()
  where ops.id=p_session for update of ops;
  if not found then raise exception 'Session access required.'; end if;
  if s.status='closed' then raise exception 'OPD already closed.'; end if;
  if p_action in ('start','next','no_show','pause','resume','close','late')
    and s.current_token is distinct from p_expected_token then
    raise exception 'Queue changed. Refresh and try again.';
  end if;

  if p_action in ('start','walkin','late') and not exists(
    select 1 from public.doctors d join public.facilities f on f.id=d.facility_id
    where d.id=s.doctor_id and f.booking_enabled and not f.is_demo
  ) then raise exception 'Activate appointment service first.'; end if;
  case p_action
  when 'walkin' then
    if s.ends_at<=now() then raise exception 'This session has ended.'; end if;
    phone_arg := regexp_replace(coalesce(p_data->>'mobile',''),'[[:space:]-]','','g');
    if phone_arg ~ '^[0-9]{10}$' then phone_arg := '+91'||phone_arg; end if;
    name_arg := nullif(btrim(p_data->>'name'),'');
    age_arg := (p_data->>'age')::integer;
    sex_arg := p_data->>'sex';
    if phone_arg !~ '^\+[1-9][0-9]{7,14}$' or name_arg is null or length(name_arg)>80
      or age_arg is null or age_arg not between 0 and 120
      or sex_arg is null or sex_arg not in ('Female','Male','Intersex','Prefer not to say') then
      raise exception 'Enter a valid name, mobile number, age and sex.';
    end if;
    select a.token into next_token from banr_private.appointments a
      where a.session_id=s.id and a.walkin_phone=phone_arg and a.status in ('waiting','serving')
      order by a.token limit 1;
    if not found then
      if s.booked_count>=s.capacity then raise exception 'Appointment limit reached.'; end if;
      update public.opd_sessions set last_token=last_token+1,booked_count=booked_count+1
      where id=s.id returning last_token into next_token;
      insert into banr_private.appointments(session_id,token,source,walkin_phone,walkin_name,walkin_age,walkin_sex)
      values(s.id,next_token,'walkin',phone_arg,name_arg,age_arg,sex_arg);
    end if;
    select count(*) into ahead from banr_private.appointments
      where session_id=s.id and token<next_token and status='waiting';
    wait_minutes := case
      when next_token=s.current_token and s.status='open' then 0
      when s.status='paused' or (s.status='late' and s.revised_start_at is null) then null
      when s.status in ('scheduled','late') then ahead*s.consultation_minutes+
        ceil(greatest(0,extract(epoch from (coalesce(s.revised_start_at,s.starts_at)-now())))/60)::integer
      else ahead*s.consultation_minutes+case when s.current_started_at is null then 0 else
        ceil(greatest(0,s.consultation_minutes-extract(epoch from (now()-s.current_started_at))/60))::integer end end;
    walkin_result := jsonb_build_object('token',next_token,'waiting_ahead',ahead,'wait_minutes',wait_minutes);
  when 'late' then
    delay_minutes := (p_data->>'delay_minutes')::integer;
    if delay_minutes is not null and delay_minutes not in (5,10,15,20,25,30) then
      raise exception 'Choose a delay of 5 to 30 minutes.';
    end if;
    revised := coalesce(clock_timestamp() + make_interval(mins => delay_minutes),
      (p_data->>'revised_start_at')::timestamptz);
    if s.status not in ('scheduled','late') or revised is null or revised<=now() or revised>=s.ends_at then
      raise exception 'Choose a future start time before the session ends.';
    end if;
    update public.opd_sessions set status='late',revised_start_at=revised where id=s.id;
  when 'pause' then
    if s.status<>'open' then raise exception 'Start OPD before pausing.'; end if;
    update public.opd_sessions set status='paused' where id=s.id;
  when 'resume' then
    if s.status<>'paused' then raise exception 'This OPD is not paused.'; end if;
    update public.opd_sessions set status='open' where id=s.id;
  when 'close' then
    select count(*) into pending from banr_private.appointments
      where session_id=s.id and status in ('waiting','serving');
    if pending is distinct from (p_data->>'pending_count')::integer then
      raise exception 'Pending patient count changed. Refresh before closing OPD.';
    end if;
    update banr_private.appointments set status='cancelled'
      where session_id=s.id and status in ('waiting','serving');
    update public.opd_sessions set status='closed',current_started_at=null where id=s.id;
  when 'start','next','no_show' then
    if p_action='start' and (s.status not in ('scheduled','late') or s.ends_at<=now()) then
      raise exception 'This OPD cannot be started.';
    elsif p_action<>'start' and s.status<>'open' then
      raise exception 'Start or resume OPD first.';
    end if;
    if p_action in ('next','no_show') and s.current_started_at + interval '10 seconds' > clock_timestamp() then
      raise exception 'Wait 10 seconds after the current token was called.';
    end if;
    if p_action='no_show' and not exists(select 1 from banr_private.appointments
      where session_id=s.id and token=s.current_token and status='serving') then
      raise exception 'No current patient to mark absent.';
    end if;
    if p_action<>'start' then
      update banr_private.appointments set status=case when p_action='no_show' then 'no_show' else 'completed' end
      where session_id=s.id and token=s.current_token and status='serving';
    end if;
    select id,token into next_id,next_token from banr_private.appointments
      where session_id=s.id and status='waiting' order by token limit 1;
    if found then
      update banr_private.appointments set status='serving' where id=next_id;
    end if;
    update public.opd_sessions set status='open',current_token=coalesce(next_token,s.current_token),
      current_started_at=case when next_token is null then null else clock_timestamp() end,
      revised_start_at=null where id=s.id;
  else raise exception 'Unknown queue action.';
  end case;
  return public.banr_provider_queue(s.id)||jsonb_build_object('walkin',walkin_result);
end;
$function$;

CREATE OR REPLACE FUNCTION public.banr_onboarding_submit(p_data jsonb, p_client text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 f text:=trim(p_data->>'facility'); c text:=trim(p_data->>'contact');
 e text:=lower(trim(p_data->>'email')); p text:=regexp_replace(p_data->>'phone','[ .()-]','','g');
 m text:=p_data->>'mode'; rid uuid; tries integer; claim text:=nullif(trim(p_data->>'claim_id'),''); initial jsonb;
begin
 if p ~ '^[0-9]{10}$' then p:='+91'||p; end if;
 if f is null or length(f) not between 2 and 120 or c is null or length(c) not between 2 and 100
   or e is null or length(e)>254 or e !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
   or p is null or p !~ '^[+][1-9][0-9]{10,14}$' or m is null or m not in ('self','assisted') then
   raise exception 'Check the facility name and contact details.';
 end if;
 insert into banr_private.onboarding_rate(key,period,attempts) values(p_client,now(),1)
 on conflict(key) do update set
   attempts=case when onboarding_rate.period < now()-interval '1 hour' then 1 else onboarding_rate.attempts+1 end,
   period=case when onboarding_rate.period < now()-interval '1 hour' then now() else onboarding_rate.period end
 returning attempts into tries;
 if tries>5 then return null; end if;
 if claim is not null then
   select name into f from public.facilities where id=claim and not is_demo and not booking_enabled;
   if not found then raise exception 'Select an available facility from the directory.'; end if;
 end if;
 initial:=jsonb_strip_nulls(jsonb_build_object('type',case when p_data->>'type' in ('Clinic','Hospital') then p_data->>'type' end,
   'address',left(p_data->>'address',500),'area',left(p_data->>'area',120),'requestedDoctors',left(p_data->>'doctor_count',4)));
 begin
 insert into banr_private.onboarding_requests(facility_name,contact_name,phone,email,mode,history,claim_facility_id,profile)
 values(f,c,p,e,m,jsonb_build_array(jsonb_build_object('status','Requested','at',now())),claim,initial) returning id into rid;
 exception when unique_violation then return '00000000-0000-0000-0000-000000000001'::uuid;
 end;
 insert into banr_private.onboarding_outbox(request_id,template,channel) values(rid,'team','team');
 if m='self' then perform banr_private.onboarding_link(rid); end if;
 return rid;
end;
$function$;

CREATE OR REPLACE FUNCTION public.banr_onboarding_admin(p_token text, p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 rid uuid; r banr_private.onboarding_requests%rowtype;
 item jsonb; details jsonb; facility text; note text;
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' or not exists(
   select 1 from banr_private.admin_sessions where token_hash=extensions.digest(p_token,'sha256') and expires_at>now()
 ) then raise exception 'Super Admin sign-in required.' using errcode='42501'; end if;
 case p_action
 when 'dashboard' then
   return jsonb_build_object(
    'requests',(select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') from (
      select id,facility_name,contact_name,phone,email,mode,status,created_at,changed_at,contacted_at,notes,history,reason,facility_id,claim_facility_id,
       changed_at<now()-interval '48 hours' and status not in ('Approved','Rejected') as stuck
      from banr_private.onboarding_requests
      where (nullif(p_data->>'mode','') is null or mode=p_data->>'mode')
        and (nullif(p_data->>'status','') is null or status=p_data->>'status')
        and (nullif(p_data->>'search','') is null or strpos(lower(concat_ws(' ',facility_name,contact_name,phone,email)),lower(p_data->>'search'))>0)
      order by created_at desc limit 100 offset least(100000,greatest(0,coalesce((p_data->>'offset')::int,0))) ) x),
    'directory',(select coalesce(jsonb_agg(to_jsonb(f) order by f.name),'[]') from (
      select id,name,address,area,booking_enabled,accepts_online,website,contact,hours,type,
       exists(select 1 from banr_private.provider_staff where facility_id=fac.id) as assigned
      from public.facilities fac where not is_demo order by name limit 200
    ) f),
    'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by a.at desc),'[]') from (
      select action,subject,at from banr_private.directory_audit order by at desc limit 50
    ) a),
    'plans',(select coalesce(jsonb_agg(to_jsonb(p) order by p.details->>'name'),'[]') from banr_private.onboarding_plans p),
    'templates',(select coalesce(jsonb_agg(to_jsonb(t) order by t.key),'[]') from banr_private.onboarding_templates t));
 when 'service_on','service_off' then
   facility:=p_data->>'facility';
   perform 1 from public.facilities where id=facility and not is_demo for update;
   if not found then raise exception 'Facility not found.'; end if;
   if p_action='service_on' and (
     not exists(select 1 from banr_private.onboarding_requests where facility_id=facility and status='Approved')
     or not exists(select 1 from banr_private.provider_staff where facility_id=facility)
     or not exists(select 1 from public.doctors d join public.opd_sessions s on s.doctor_id=d.id
       where d.facility_id=facility and d.available_for_booking and s.ends_at>now() and s.status in ('scheduled','late','open','paused'))
   ) then raise exception 'Approve the facility, assign staff and configure an upcoming OPD session before activating.'; end if;
   if p_action='service_off' and exists(
     select 1 from public.doctors d join public.opd_sessions s on s.doctor_id=d.id
       join banr_private.appointments a on a.session_id=s.id
     where d.facility_id=facility and s.ends_at>now() and a.status in ('waiting','serving')
   ) then raise exception 'Resolve active appointments before deactivating the service.'; end if;
   update public.facilities set booking_enabled=(p_action='service_on'),directory_only=(p_action='service_off') where id=facility;
   insert into banr_private.directory_audit(action,subject) values(p_action,facility);
   return '{}';
 when 'directory_save' then
   facility:=p_data->>'facility';
   if nullif(trim(p_data->>'name'),'') is null or nullif(trim(p_data->>'address'),'') is null
      or nullif(trim(p_data->>'area'),'') is null or coalesce(p_data->>'type','') not in ('Clinic','Hospital') then
     raise exception 'Name, type, area and address are required.';
   end if;
   if coalesce(p_data->>'website','')<>'' and p_data->>'website' !~ '^https://' then raise exception 'Website must use HTTPS.'; end if;
   if coalesce(p_data->>'contact','')<>'' and p_data->>'contact' !~ '^[+0-9 ()-]{7,24}$' then raise exception 'Enter a valid contact number.'; end if;
   if facility is null or facility='' then
     if exists(select 1 from public.facilities where lower(trim(name))=lower(trim(p_data->>'name')) and lower(trim(address))=lower(trim(p_data->>'address'))) then
       raise exception 'A matching facility already exists.';
     end if;
     facility:='directory-'||gen_random_uuid()::text;
     insert into public.facilities(id,name,type,area,address,hours,contact,website,directory_only)
     values(facility,left(trim(p_data->>'name'),120),p_data->>'type',left(trim(p_data->>'area'),120),left(trim(p_data->>'address'),500),
       coalesce(nullif(left(trim(p_data->>'hours'),150),''),'Hours unavailable'),nullif(p_data->>'contact',''),nullif(p_data->>'website',''),true);
   else
     update public.facilities set name=left(trim(p_data->>'name'),120),type=p_data->>'type',area=left(trim(p_data->>'area'),120),
       address=left(trim(p_data->>'address'),500),hours=coalesce(nullif(left(trim(p_data->>'hours'),150),''),'Hours unavailable'),
       contact=nullif(p_data->>'contact',''),website=nullif(p_data->>'website','') where id=facility and not is_demo;
     if not found then raise exception 'Facility not found.'; end if;
   end if;
   insert into banr_private.directory_audit(action,subject) values(p_action,facility);
   return jsonb_build_object('id',facility);
 when 'plan_save' then
   details:=p_data->'details';
   if jsonb_typeof(details) is distinct from 'object' or octet_length(details::text)>12000
     or nullif(trim(details->>'name'),'') is null or nullif(trim(details->>'cycle'),'') is null
     or nullif(trim(details->>'currency'),'') is null or jsonb_typeof(details->'price') is distinct from 'number'
     or jsonb_typeof(details->'features') is distinct from 'array' or jsonb_typeof(details->'limits') is distinct from 'object' then
     raise exception 'Enter a plan name, price, currency, billing cycle, features and limits.';
   end if;
   if nullif(p_data->>'id','') is null then
    insert into banr_private.onboarding_plans(details,active) values(details,coalesce((p_data->>'active')::boolean,true)) returning id into rid;
   else
    rid:=(p_data->>'id')::uuid;
    update banr_private.onboarding_plans set details=p_data->'details',active=(p_data->>'active')::boolean where id=rid;
   end if;
   return jsonb_build_object('id',rid);
 when 'plan_delete' then
   delete from banr_private.onboarding_plans where id=(p_data->>'id')::uuid;
   return '{}';
 when 'template_save' then
   if length(coalesce(p_data->>'subject','')) not between 1 and 200 or length(coalesce(p_data->>'body','')) not between 1 and 10000
    or (p_data->>'key'='registration' and strpos(p_data->>'body','{{link}}')=0)
    or (p_data->>'key'='verification' and strpos(p_data->>'body','{{verification_link}}')=0) then
     raise exception 'Enter a subject and body, and keep the required link placeholder.';
   end if;
   update banr_private.onboarding_templates set subject=p_data->>'subject',body=p_data->>'body' where key=p_data->>'key';
   return '{}';
 else null;
 end case;
 rid:=(p_data->>'id')::uuid;
 select * into r from banr_private.onboarding_requests where id=rid for update;
 if not found then raise exception 'Request not found.'; end if;
 case p_action
 when 'request' then
   return jsonb_build_object('profile',r.profile,'plan',r.plan,'history',r.history,'owner',r.user_id,
    'messages',(select coalesce(jsonb_agg(jsonb_build_object('channel',channel,'template',template,'attempts',attempts,
     'sentAt',sent_at,'failedAt',failed_at,'lastError',last_error,'createdAt',created_at) order by created_at desc),'[]')
     from banr_private.onboarding_outbox where request_id=rid));
 when 'resend','convert' then
   if r.mode='assisted' and p_action<>'convert' then raise exception 'Convert this assisted request first.'; end if;
   update banr_private.onboarding_requests set mode='self' where id=rid;
   perform banr_private.onboarding_link(rid);
 when 'link_claim' then
   facility:=p_data->>'facility';
   if r.status in ('Approved','Rejected') or not exists(select 1 from public.facilities where id=facility and not is_demo and not booking_enabled) then
     raise exception 'This claim cannot be linked.';
   end if;
   update banr_private.onboarding_requests set claim_facility_id=facility where id=rid;
   insert into banr_private.directory_audit(action,subject) values(p_action,rid::text);
 when 'contact' then update banr_private.onboarding_requests set contacted_at=now() where id=rid;
 when 'note' then
   note:=trim(p_data->>'note');
   if note is null or length(note) not between 1 and 3000 then raise exception 'Enter a follow-up note.'; end if;
   update banr_private.onboarding_requests set notes=notes||jsonb_build_array(jsonb_build_object('text',note,'at',now())) where id=rid;
 when 'approve' then
   if r.status<>'Pending Approval' or r.user_id is null then raise exception 'Only complete applications can be approved.'; end if;
   perform pg_advisory_xact_lock(hashtext('banr-facility-approval'));
   facility:=r.claim_facility_id;
   if facility is null then
     if exists(select 1 from public.facilities where not is_demo
       and lower(trim(name))=lower(trim(r.facility_name)) and lower(trim(address))=lower(trim(r.profile->>'address'))) then
       raise exception 'A matching directory listing already exists. Link it before approval.';
     end if;
     facility:='provider-'||rid::text;
     insert into public.facilities(id,name,type,area,address,hours,latitude,longitude,contact,directory_only)
     values(facility,r.facility_name,r.profile->>'type',r.profile->>'area',r.profile->>'address',r.profile->>'hours',
       (r.profile->>'latitude')::double precision,(r.profile->>'longitude')::double precision,r.phone,true);
   else
     perform 1 from public.facilities where id=facility and not is_demo and not booking_enabled for update;
     if not found or exists(select 1 from banr_private.onboarding_requests where facility_id=facility and status='Approved') then
       raise exception 'This listing already has a verified provider or is unavailable.';
     end if;
   end if;
   for item in select value from jsonb_array_elements(r.profile->'doctors') loop
     insert into public.doctors(facility_id,name,specialty,fee,consultation_minutes)
      values(facility,item->>'name',item->>'specialty',(item->>'fee')::integer,(item->>'minutes')::integer);
   end loop;
   insert into banr_private.provider_staff(user_id,facility_id) values(r.user_id,facility) on conflict do nothing;
   update banr_private.onboarding_requests set facility_id=facility where id=rid;
   perform banr_private.onboarding_step(rid,'Approved');
   insert into banr_private.directory_audit(action,subject) values('verified',facility);
   insert into banr_private.onboarding_outbox(request_id,template,channel,destination)
    values(rid,'approval','email',r.email),(rid,'approval','sms',r.phone);
 when 'reject' then
   note:=trim(p_data->>'reason');
   if r.status<>'Pending Approval' or note is null or length(note) not between 1 and 3000 then raise exception 'A pending application and rejection reason are required.'; end if;
   update banr_private.onboarding_requests set reason=note where id=rid;
   perform banr_private.onboarding_step(rid,'Rejected');
   insert into banr_private.directory_audit(action,subject) values('rejected',rid::text);
   insert into banr_private.onboarding_outbox(request_id,template,channel,destination,variables)
    values(rid,'rejection','email',r.email,jsonb_build_object('reason',note)),(rid,'rejection','sms',r.phone,jsonb_build_object('reason',note));
 else raise exception 'Unknown action.';
 end case;
 return '{}';
end;
$function$;

create function public.banr_book_session_with_contact(p_session uuid,p_name text,p_age integer,p_sex text,p_mobile text)
returns uuid language plpgsql security definer set search_path='' as $$
declare booking uuid; phone text:=regexp_replace(coalesce(p_mobile,''),'[ .()-]','','g');
begin
 if auth.uid() is null then raise exception 'Sign in before booking.'; end if;
 if phone ~ '^[0-9]{10}$' then phone:='+91'||phone; end if;
 if phone !~ '^[+][1-9][0-9]{9,14}$' then raise exception 'Enter a valid mobile number.'; end if;
 booking:=banr_private.book_session(p_session,p_name,p_age,p_sex);
 update public.patient_profiles set mobile=phone where user_id=auth.uid();
 return booking;
end;
$$;
create function public.banr_cancel_appointment(p_appointment uuid)
returns void language plpgsql security definer set search_path='' as $$
declare s_id uuid; s public.opd_sessions%rowtype;
begin
 select session_id into s_id from banr_private.appointments where id=p_appointment and patient_id=auth.uid() and source='online';
 if not found then raise exception 'Appointment not found.'; end if;
 select * into s from public.opd_sessions where id=s_id for update;
 if s.status not in ('scheduled','late') or s.ends_at<=now() then raise exception 'Online cancellation closes when the OPD starts. Contact reception.'; end if;
 update banr_private.appointments set status='cancelled' where id=p_appointment and status='waiting' and patient_id=auth.uid();
 if not found then raise exception 'This appointment cannot be cancelled.'; end if;
 update public.opd_sessions set booked_count=booked_count-1 where id=s_id;
end;
$$;
create function public.banr_provider_booking_settings(p_facility text,p_online boolean,p_days integer)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from banr_private.provider_staff where facility_id=p_facility and user_id=auth.uid()) then
   raise exception 'Facility staff access required.' using errcode='42501';
 end if;
 if p_online is null or p_days is null or p_days not between 0 and 90 then raise exception 'Choose 0 to 90 days.'; end if;
 update public.facilities set accepts_online=p_online,advance_booking_days=p_days where id=p_facility and not is_demo;
end;
$$;
revoke execute on function public.banr_book_session_with_contact(uuid,text,integer,text,text),public.banr_cancel_appointment(uuid),
public.banr_provider_booking_settings(text,boolean,integer) from public,anon,authenticated;
grant execute on function public.banr_book_session_with_contact(uuid,text,integer,text,text),public.banr_cancel_appointment(uuid),
public.banr_provider_booking_settings(text,boolean,integer) to authenticated;
commit;