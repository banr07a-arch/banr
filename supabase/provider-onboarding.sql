begin;
create table banr_private.onboarding_plans (
 id uuid primary key default gen_random_uuid(), details jsonb not null, active boolean not null default true
);
insert into banr_private.onboarding_plans(details) values
 ('{"name":"Basic","price":499,"currency":"INR","cycle":"monthly","features":["Clinic listing","Online booking"],"limits":{"doctors":2,"bookings":100}}'),
 ('{"name":"Standard","price":999,"currency":"INR","cycle":"monthly","features":["Clinic listing","Online booking","Live tokens"],"limits":{"doctors":10,"bookings":500}}'),
 ('{"name":"Premium","price":14999,"currency":"INR","cycle":"yearly","features":["Hospital listing","Online booking","Live tokens"],"limits":{"doctors":50,"bookings":5000}}');
create table banr_private.onboarding_requests (
 id uuid primary key default gen_random_uuid(), facility_name text not null, contact_name text not null,
 phone text not null, email text not null, mode text not null check(mode in ('self','assisted')),
 status text not null default 'Requested' check(status in ('Requested','Link Sent','Link Opened','Registered','Email Verified','Profile Completed','Pending Approval','Approved','Rejected')),
 created_at timestamptz not null default now(), changed_at timestamptz not null default now(),
 contacted_at timestamptz, notes jsonb not null default '[]', history jsonb not null default '[]',
 token_hash bytea unique, token_expires timestamptz, user_id uuid references auth.users(id) on delete set null,
 profile jsonb not null default '{}', plan jsonb, reason text, facility_id text references public.facilities(id)
);
create unique index onboarding_pending_email on banr_private.onboarding_requests(email) where status not in ('Approved','Rejected');
create unique index onboarding_pending_phone on banr_private.onboarding_requests(phone) where status not in ('Approved','Rejected');
create unique index onboarding_owner on banr_private.onboarding_requests(user_id) where user_id is not null;
create table banr_private.onboarding_rate (
 key text primary key, period timestamptz not null, attempts integer not null
);
create table banr_private.onboarding_templates (
 key text primary key, subject text not null, body text not null
);
insert into banr_private.onboarding_templates values
 ('registration','Complete your BANR registration','Hello {{contact}}, register {{facility}} here: {{link}}'),
 ('verification','Verify your BANR email','Confirm your email to continue: {{verification_link}}'),
 ('approval','Your BANR application is approved','{{facility}} has been approved. You can sign in at {{portal}}.'),
 ('rejection','Your BANR application needs attention','We could not approve {{facility}}. Reason: {{reason}}'),
 ('team','New BANR provider request','{{facility}} submitted a {{mode}} request. Review it in Super Admin.');
create table banr_private.onboarding_outbox (
 id uuid primary key default gen_random_uuid(), request_id uuid not null references banr_private.onboarding_requests(id),
 template text not null references banr_private.onboarding_templates(key), channel text not null check(channel in ('sms','email','team')),
 destination text, variables jsonb not null default '{}', attempts integer not null default 0,
 available_at timestamptz not null default now(), sent_at timestamptz, failed_at timestamptz, last_error text,
 created_at timestamptz not null default now()
);
create index onboarding_outbox_due on banr_private.onboarding_outbox(available_at) where sent_at is null and failed_at is null;
do $ddl$
declare t text;
begin
 foreach t in array array['onboarding_plans','onboarding_requests','onboarding_rate','onboarding_templates','onboarding_outbox'] loop
   execute format('alter table banr_private.%I enable row level security',t);
   execute format('revoke all on banr_private.%I from public, anon, authenticated',t);
 end loop;
end $ddl$;

create function banr_private.onboarding_step(p_id uuid, p_status text)
returns void language sql set search_path='' as $$
 update banr_private.onboarding_requests
 set status=p_status, changed_at=now(), history=history||jsonb_build_array(jsonb_build_object('status',p_status,'at',now()))
 where id=p_id and status<>p_status;
$$;
create function banr_private.onboarding_link(p_id uuid)
returns void language plpgsql set search_path='' as $$
declare
 t text:=encode(extensions.gen_random_bytes(32),'hex');
 r banr_private.onboarding_requests%rowtype;
begin
 select * into r from banr_private.onboarding_requests where id=p_id for update;
 if not found or r.status not in ('Requested','Link Sent','Link Opened') then raise exception 'The registration link can no longer be issued.'; end if;
 if exists(select 1 from banr_private.onboarding_outbox where request_id=p_id and template='registration'
   and created_at > now()-interval '1 minute') then raise exception 'Wait one minute before sending another link.'; end if;
 update banr_private.onboarding_requests set token_hash=extensions.digest(t,'sha256'),token_expires=now()+interval '48 hours' where id=p_id;
 update banr_private.onboarding_outbox set failed_at=now(),last_error='Superseded by a newer link',variables=variables-'token'
 where request_id=p_id and template='registration' and sent_at is null and failed_at is null;
 insert into banr_private.onboarding_outbox(request_id,template,channel,destination,variables)
 values(p_id,'registration','email',r.email,jsonb_build_object('token',t)),(p_id,'registration','sms',r.phone,jsonb_build_object('token',t));
end;
$$;

create function public.banr_onboarding_plans()
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(details||jsonb_build_object('id',id) order by details->>'name'),'[]'::jsonb)
 from banr_private.onboarding_plans where active;
$$;

create function public.banr_onboarding_submit(p_data jsonb,p_client text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 f text:=trim(p_data->>'facility'), c text:=trim(p_data->>'contact'),
 e text:=lower(trim(p_data->>'email')), p text:=regexp_replace(p_data->>'phone','[ .()-]','','g'),
 m text:=p_data->>'mode', rid uuid, tries integer;
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
 begin
 insert into banr_private.onboarding_requests(facility_name,contact_name,phone,email,mode,history)
 values(f,c,p,e,m,jsonb_build_array(jsonb_build_object('status','Requested','at',now()))) returning id into rid;
 exception when unique_violation then return '00000000-0000-0000-0000-000000000001'::uuid;
 end;
 insert into banr_private.onboarding_outbox(request_id,template,channel) values(rid,'team','team');
 if m='self' then perform banr_private.onboarding_link(rid); end if;
 return rid;
end;
$$;

create function public.banr_onboarding_open(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r banr_private.onboarding_requests%rowtype;
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return null; end if;
 select * into r from banr_private.onboarding_requests where token_hash=extensions.digest(p_token,'sha256') and token_expires>now()
 and user_id is null and status in ('Requested','Link Sent','Link Opened','Registered') for update;
 if not found then return null; end if;
 if r.status in ('Requested','Link Sent') then perform banr_private.onboarding_step(r.id,'Link Opened'); end if;
 return jsonb_build_object('facility',r.facility_name,'email',r.email,'phone',r.phone);
end;
$$;

create function public.banr_onboarding_registered(p_token text)
returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return; end if;
 select id into rid from banr_private.onboarding_requests where token_hash=extensions.digest(p_token,'sha256') and token_expires>now()
 and status='Link Opened' and exists(select 1 from auth.users u where lower(u.email)=onboarding_requests.email) for update;
 if found then perform banr_private.onboarding_step(rid,'Registered'); end if;
end;
$$;

create function public.banr_onboarding_profile(p_action text,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid(); u auth.users%rowtype; r banr_private.onboarding_requests%rowtype;
 plan_data jsonb; profile_data jsonb; path text;
begin
 if uid is null then raise exception 'Sign in to continue.'; end if;
 select * into u from auth.users where id=uid and email_confirmed_at is not null;
 if not found then raise exception 'Confirm your email first.'; end if;
 select * into r from banr_private.onboarding_requests where user_id=uid for update;
 if not found and p_action='claim' then
   select * into r from banr_private.onboarding_requests
   where email=lower(u.email) and user_id is null and token_expires>now()
     and ((token_hash=extensions.digest(p_data->>'token','sha256') and status in ('Link Opened','Registered'))
       or (nullif(p_data->>'token','') is null and status='Registered')) for update;
   if found then
     if r.status='Link Opened' then perform banr_private.onboarding_step(r.id,'Registered'); end if;
     update banr_private.onboarding_requests set user_id=uid,token_hash=null,token_expires=null where id=r.id;
     perform banr_private.onboarding_step(r.id,'Email Verified');
     r.status:='Email Verified';
   end if;
 end if;
 if r.id is null then return null; end if;
 if p_action in ('save','submit') then
   if r.status not in ('Email Verified','Profile Completed') then raise exception 'This application is locked for review.'; end if;
   profile_data:=p_data->'profile';
   if jsonb_typeof(profile_data) is distinct from 'object' or octet_length(profile_data::text)>60000 then raise exception 'Invalid profile.'; end if;
   if exists(select 1 from unnest(array['doctors','photos','documents']) k
     where profile_data ? k and jsonb_typeof(profile_data->k) <> 'array') then raise exception 'Invalid profile fields.'; end if;
   select details||jsonb_build_object('id',id) into plan_data from banr_private.onboarding_plans where id=nullif(p_data->>'plan_id','')::uuid and active;
   if plan_data is null and r.plan->>'id'=p_data->>'plan_id' then plan_data:=r.plan; end if;
   if p_action='submit' then
     if u.phone_confirmed_at is null or '+'||ltrim(coalesce(u.phone,''),'+')<>r.phone then raise exception 'Verify the request phone number first.'; end if;
     if plan_data is null or coalesce(profile_data->>'type','') not in ('Clinic','Hospital')
       or exists(select 1 from unnest(array['address','area','license','specialties','hours','payout']) k where nullif(trim(profile_data->>k),'') is null)
       or length(profile_data->>'address')>500 or length(profile_data->>'license')>120
       or coalesce(profile_data->>'latitude','') !~ '^-?[0-9]+([.][0-9]+)?$'
       or coalesce(profile_data->>'longitude','') !~ '^-?[0-9]+([.][0-9]+)?$'
       or (profile_data->>'latitude')::numeric not between -90 and 90 or (profile_data->>'longitude')::numeric not between -180 and 180
       or jsonb_typeof(profile_data->'doctors') is distinct from 'array'
       or jsonb_typeof(profile_data->'photos') is distinct from 'array'
       or jsonb_typeof(profile_data->'documents') is distinct from 'array' then raise exception 'Complete all profile fields and choose a plan.'; end if;
     if jsonb_array_length(profile_data->'doctors') not between 1 and 100
       or jsonb_array_length(profile_data->'photos') not between 1 and 20
       or jsonb_array_length(profile_data->'documents') not between 1 and 20
       or exists(select 1 from jsonb_array_elements(profile_data->'doctors') d
         where nullif(trim(d->>'name'),'') is null or nullif(trim(d->>'specialty'),'') is null
          or coalesce(d->>'fee','') !~ '^[0-9]{1,6}$' or coalesce(d->>'minutes','') !~ '^[1-9][0-9]{0,2}$') then
       raise exception 'Add valid doctors, photos and license documents.';
     end if;
     for path in select jsonb_array_elements_text(profile_data->'photos'||profile_data->'documents') loop
       if not exists(select 1 from storage.objects where bucket_id='banr-provider-uploads' and name=path and split_part(name,'/',1)=uid::text) then
         raise exception 'An uploaded file could not be verified.';
       end if;
     end loop;
   end if;
   update banr_private.onboarding_requests set profile=profile_data,plan=plan_data where id=r.id returning * into r;
   if p_action='submit' then
     perform banr_private.onboarding_step(r.id,'Profile Completed');
     perform banr_private.onboarding_step(r.id,'Pending Approval');
     r.status:='Pending Approval';
   end if;
 end if;
 return jsonb_build_object('id',r.id,'facility',r.facility_name,'phone',r.phone,'status',r.status,
   'profile',r.profile,'plan',r.plan,'reason',r.reason,'phoneVerified',
   u.phone_confirmed_at is not null and '+'||ltrim(coalesce(u.phone,''),'+')=r.phone);
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('banr-provider-uploads','banr-provider-uploads',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf']);
create policy banr_onboard_upload on storage.objects for insert to authenticated with check (
 bucket_id='banr-provider-uploads' and (storage.foldername(name))[1]=auth.uid()::text);
create policy banr_onboard_files on storage.objects for select to authenticated using (
 bucket_id='banr-provider-uploads' and (storage.foldername(name))[1]=auth.uid()::text);

revoke execute on function banr_private.onboarding_step(uuid,text),banr_private.onboarding_link(uuid),
 public.banr_onboarding_plans(),public.banr_onboarding_open(text),public.banr_onboarding_registered(text),
 public.banr_onboarding_profile(text,jsonb),public.banr_onboarding_submit(jsonb,text) from public,anon,authenticated;
grant execute on function public.banr_onboarding_plans(),public.banr_onboarding_open(text),public.banr_onboarding_registered(text) to anon,authenticated;
grant execute on function public.banr_onboarding_profile(text,jsonb) to authenticated;
grant execute on function public.banr_onboarding_submit(jsonb,text) to service_role;

create function public.banr_onboarding_admin(p_token text,p_action text,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
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
      select id,facility_name,contact_name,phone,email,mode,status,created_at,changed_at,contacted_at,notes,history,reason,facility_id,
       changed_at<now()-interval '48 hours' and status not in ('Approved','Rejected') as stuck
      from banr_private.onboarding_requests
      where (nullif(p_data->>'mode','') is null or mode=p_data->>'mode')
        and (nullif(p_data->>'status','') is null or status=p_data->>'status')
        and (nullif(p_data->>'search','') is null or strpos(lower(concat_ws(' ',facility_name,contact_name,phone,email)),lower(p_data->>'search'))>0)
      order by created_at desc limit 100 offset least(100000,greatest(0,coalesce((p_data->>'offset')::int,0))) ) x),
    'plans',(select coalesce(jsonb_agg(to_jsonb(p) order by p.details->>'name'),'[]') from banr_private.onboarding_plans p),
    'templates',(select coalesce(jsonb_agg(to_jsonb(t) order by t.key),'[]') from banr_private.onboarding_templates t));
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
 when 'contact' then update banr_private.onboarding_requests set contacted_at=now() where id=rid;
 when 'note' then
   note:=trim(p_data->>'note');
   if note is null or length(note) not between 1 and 3000 then raise exception 'Enter a follow-up note.'; end if;
   update banr_private.onboarding_requests set notes=notes||jsonb_build_array(jsonb_build_object('text',note,'at',now())) where id=rid;
 when 'approve' then
   if r.status<>'Pending Approval' or r.user_id is null then raise exception 'Only complete applications can be approved.'; end if;
   facility:='provider-'||rid::text;
   insert into public.facilities(id,name,type,area,address,hours,latitude,longitude)
    values(facility,r.facility_name,r.profile->>'type',r.profile->>'area',r.profile->>'address',r.profile->>'hours',
     (r.profile->>'latitude')::double precision,(r.profile->>'longitude')::double precision);
   for item in select value from jsonb_array_elements(r.profile->'doctors') loop
     insert into public.doctors(facility_id,name,specialty,fee,consultation_minutes)
      values(facility,item->>'name',item->>'specialty',(item->>'fee')::integer,(item->>'minutes')::integer);
   end loop;
   insert into banr_private.provider_staff(user_id,facility_id) values(r.user_id,facility) on conflict do nothing;
   update banr_private.onboarding_requests set facility_id=facility where id=rid;
   perform banr_private.onboarding_step(rid,'Approved');
   insert into banr_private.onboarding_outbox(request_id,template,channel,destination)
    values(rid,'approval','email',r.email),(rid,'approval','sms',r.phone);
 when 'reject' then
   note:=trim(p_data->>'reason');
   if r.status<>'Pending Approval' or note is null or length(note) not between 1 and 3000 then raise exception 'A pending application and rejection reason are required.'; end if;
   update banr_private.onboarding_requests set reason=note where id=rid;
   perform banr_private.onboarding_step(rid,'Rejected');
   insert into banr_private.onboarding_outbox(request_id,template,channel,destination,variables)
    values(rid,'rejection','email',r.email,jsonb_build_object('reason',note)),(rid,'rejection','sms',r.phone,jsonb_build_object('reason',note));
 else raise exception 'Unknown action.';
 end case;
 return '{}';
end;
$$;

create function public.banr_onboarding_verification(p_token text,p_link text)
returns uuid language plpgsql security definer set search_path='' as $$
declare r banr_private.onboarding_requests%rowtype;
begin
 select * into r from banr_private.onboarding_requests
 where token_hash=extensions.digest(p_token,'sha256') and token_expires>now() and status in ('Link Opened','Registered') for update;
 if not found then return null; end if;
 perform banr_private.onboarding_step(r.id,'Registered');
 insert into banr_private.onboarding_outbox(request_id,template,channel,destination,variables)
 values(r.id,'verification','email',r.email,jsonb_build_object('verification_link',p_link));
 return r.id;
end;
$$;

create function public.banr_onboarding_claim_messages(p_request uuid default null)
returns jsonb language sql security definer set search_path='' as $$
 with due as (
  select o.id from banr_private.onboarding_outbox o
  where sent_at is null and failed_at is null and available_at<=now()
   and (p_request is null or request_id=p_request)
  order by (template='registration') desc,created_at limit 30 for update skip locked
 ), claimed as (
  update banr_private.onboarding_outbox o set attempts=attempts+1,available_at=now()+interval '5 minutes'
  from due where o.id=due.id returning o.*
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',o.id,'channel',o.channel,'destination',o.destination,'attempt',o.attempts,'subject',t.subject,'body',t.body,
  'vars',jsonb_build_object('contact',r.contact_name,'facility',r.facility_name,'mode',r.mode)||o.variables
 )),'[]')
 from claimed o join banr_private.onboarding_requests r on r.id=o.request_id
 join banr_private.onboarding_templates t on t.key=o.template;
$$;

create function public.banr_onboarding_message_result(p_id uuid,p_attempt int,p_ok boolean,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare o banr_private.onboarding_outbox%rowtype;
begin
 update banr_private.onboarding_outbox
 set sent_at=case when p_ok then now() else null end,
     failed_at=case when not p_ok and attempts>=5 then now() else null end,
     last_error=case when p_ok then null else left(p_error,200) end,
     available_at=now()+make_interval(mins=>least(120,attempts*5)),
     variables=case when p_ok or attempts>=5 then variables-'token'-'verification_link' else variables end
 where id=p_id and attempts=p_attempt and sent_at is null and failed_at is null returning * into o;
 if found and p_ok and o.template='registration' then
   perform 1 from banr_private.onboarding_requests where id=o.request_id and status='Requested' for update;
   if found and not exists(select 1 from banr_private.onboarding_outbox
       where request_id=o.request_id and template='registration' and created_at=(select max(created_at) from banr_private.onboarding_outbox where request_id=o.request_id and template='registration') and sent_at is null) then
     perform banr_private.onboarding_step(o.request_id,'Link Sent');
   end if;
 end if;
end;
$$;

create function public.banr_onboarding_delivery(p_request uuid,p_template text)
returns boolean language sql security definer set search_path='' as $$
 select coalesce(bool_and(sent_at is not null) filter(where created_at=(
  select max(created_at) from banr_private.onboarding_outbox where request_id=p_request and template=p_template
 )),false) from banr_private.onboarding_outbox where request_id=p_request and template=p_template;
$$;
revoke execute on function public.banr_onboarding_admin(text,text,jsonb),public.banr_onboarding_verification(text,text),
 public.banr_onboarding_claim_messages(uuid),public.banr_onboarding_message_result(uuid,int,boolean,text),
 public.banr_onboarding_delivery(uuid,text) from public,anon,authenticated;
grant execute on function public.banr_onboarding_admin(text,text,jsonb) to anon,service_role;
grant execute on function public.banr_onboarding_open(text) to service_role;
grant execute on function public.banr_onboarding_verification(text,text),public.banr_onboarding_claim_messages(uuid),
 public.banr_onboarding_message_result(uuid,int,boolean,text),public.banr_onboarding_delivery(uuid,text) to service_role;
create function public.banr_onboarding_resend_verification(p_token text)
returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from banr_private.onboarding_requests r
  where r.token_hash=extensions.digest(p_token,'sha256') and r.token_expires>now() and r.status='Registered'
   and exists(select 1 from auth.users u where lower(u.email)=r.email and u.email_confirmed_at is null)
   and not exists(select 1 from banr_private.onboarding_outbox o where o.request_id=r.id and o.template='verification' and o.created_at>now()-interval '1 minute'));
$$;
revoke execute on function public.banr_onboarding_resend_verification(text) from public,anon,authenticated;
grant execute on function public.banr_onboarding_resend_verification(text) to service_role;
commit;
