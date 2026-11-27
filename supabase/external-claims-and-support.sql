begin;
alter table public.facilities add column if not exists photo_url text;
alter table banr_private.onboarding_requests add column if not exists claim_external_id text;
create unique index if not exists onboarding_active_external_claim on banr_private.onboarding_requests(claim_external_id)
  where claim_external_id is not null and status not in ('Approved','Rejected');
create table banr_private.support_tickets (
 id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete set null,
 subject text not null,message text not null,status text not null default 'Open',created_at timestamptz not null default now()
);
alter table banr_private.support_tickets enable row level security;
revoke all on banr_private.support_tickets from public,anon,authenticated;
create function public.banr_support_request(p_subject text,p_message text)
returns uuid language plpgsql security definer set search_path='' as $$
declare new_id uuid;
begin
 if auth.uid() is null then raise exception 'Sign in first.'; end if;
 if coalesce(length(trim(p_subject)),0) not between 3 and 120 or coalesce(length(trim(p_message)),0) not between 10 and 2000 then
   raise exception 'Enter a subject and a message of 10 to 2000 characters.';
 end if;
 perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
 if (select count(*) from banr_private.support_tickets where user_id=auth.uid() and created_at>now()-interval '1 hour')>=5 then
   raise exception 'Too many support requests. Try again later.';
 end if;
 insert into banr_private.support_tickets(user_id,subject,message) values(auth.uid(),trim(p_subject),trim(p_message)) returning id into new_id;
 return new_id;
end;
$$;
revoke execute on function public.banr_support_request(text,text) from public,anon,authenticated;
grant execute on function public.banr_support_request(text,text) to authenticated;
CREATE OR REPLACE FUNCTION public.banr_onboarding_submit(p_data jsonb, p_client text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 f text:=trim(p_data->>'facility'); c text:=trim(p_data->>'contact');
 e text:=lower(trim(p_data->>'email')); p text:=regexp_replace(p_data->>'phone','[ .()-]','','g');
 m text:=p_data->>'mode'; rid uuid; tries integer; claim text:=nullif(trim(p_data->>'claim_id'),''); initial jsonb; external_id text:=nullif(p_data->>'external_id','');
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
 if external_id is not null then
   if external_id !~ '^osm:(node|way|relation)/[1-9][0-9]{0,17}$' then raise exception 'Invalid external listing.'; end if;
   if claim is null then select id into claim from public.facilities where external_place_id=external_id; end if;
 end if;
 if claim is not null then
   select name into f from public.facilities where id=claim and not is_demo and not booking_enabled;
   if not found then raise exception 'Select an available facility from the directory.'; end if;
 end if;
 initial:=jsonb_strip_nulls(jsonb_build_object('type',case when p_data->>'type' in ('Clinic','Hospital') then p_data->>'type' end,
   'address',left(p_data->>'address',500),'area',left(p_data->>'area',120),'requestedDoctors',left(p_data->>'doctor_count',4)));
 begin
 insert into banr_private.onboarding_requests(facility_name,contact_name,phone,email,mode,history,claim_facility_id,profile,claim_external_id)
 values(f,c,p,e,m,jsonb_build_array(jsonb_build_object('status','Requested','at',now())),claim,initial,external_id) returning id into rid;
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
      select id,facility_name,contact_name,phone,email,mode,status,created_at,changed_at,contacted_at,notes,history,reason,facility_id,claim_facility_id,claim_external_id,
       changed_at<now()-interval '48 hours' and status not in ('Approved','Rejected') as stuck
      from banr_private.onboarding_requests
      where (nullif(p_data->>'mode','') is null or mode=p_data->>'mode')
        and (nullif(p_data->>'status','') is null or status=p_data->>'status')
        and (nullif(p_data->>'search','') is null or strpos(lower(concat_ws(' ',facility_name,contact_name,phone,email)),lower(p_data->>'search'))>0)
      order by created_at desc limit 100 offset least(100000,greatest(0,coalesce((p_data->>'offset')::int,0))) ) x),
    'directory',(select coalesce(jsonb_agg(to_jsonb(f) order by f.name),'[]') from (
      select id,name,address,area,booking_enabled,accepts_online,website,contact,hours,type,photo_url,latitude,longitude,
       exists(select 1 from banr_private.provider_staff where facility_id=fac.id) as assigned
      from public.facilities fac where not is_demo order by name limit 200
    ) f),
    'support',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc),'[]') from (
     select id,subject,message,status,created_at from banr_private.support_tickets order by created_at desc limit 100
    ) t),
    'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by a.at desc),'[]') from (
      select action,subject,at from banr_private.directory_audit order by at desc limit 50
    ) a),
    'plans',(select coalesce(jsonb_agg(to_jsonb(p) order by p.details->>'name'),'[]') from banr_private.onboarding_plans p),
    'templates',(select coalesce(jsonb_agg(to_jsonb(t) order by t.key),'[]') from banr_private.onboarding_templates t));
 when 'support_resolve' then
   update banr_private.support_tickets set status='Resolved' where id=(p_data->>'id')::uuid;
   if not found then raise exception 'Support request not found.'; end if;
   insert into banr_private.directory_audit(action,subject) values(p_action,p_data->>'id');
   return '{}';
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
   if coalesce(p_data->>'photo_url','')<>'' and p_data->>'photo_url' !~ '^https://' then raise exception 'Photo URL must use HTTPS.'; end if;
   if coalesce(p_data->>'contact','')<>'' and p_data->>'contact' !~ '^[+0-9 ()-]{7,24}$' then raise exception 'Enter a valid contact number.'; end if;
   if facility is null or facility='' then
     if exists(select 1 from public.facilities where lower(trim(name))=lower(trim(p_data->>'name')) and lower(trim(address))=lower(trim(p_data->>'address'))) then
       raise exception 'A matching facility already exists.';
     end if;
     facility:='directory-'||gen_random_uuid()::text;
     insert into public.facilities(id,name,type,area,address,hours,contact,website,directory_only,photo_url,latitude,longitude)
     values(facility,left(trim(p_data->>'name'),120),p_data->>'type',left(trim(p_data->>'area'),120),left(trim(p_data->>'address'),500),
       coalesce(nullif(left(trim(p_data->>'hours'),150),''),'Hours unavailable'),nullif(p_data->>'contact',''),nullif(p_data->>'website',''),true,nullif(p_data->>'photo_url',''),
      nullif(p_data->>'latitude','')::double precision,nullif(p_data->>'longitude','')::double precision);
   else
     update public.facilities set name=left(trim(p_data->>'name'),120),type=p_data->>'type',area=left(trim(p_data->>'area'),120),
       address=left(trim(p_data->>'address'),500),hours=coalesce(nullif(left(trim(p_data->>'hours'),150),''),'Hours unavailable'),
       contact=nullif(p_data->>'contact',''),website=nullif(p_data->>'website',''),photo_url=nullif(p_data->>'photo_url',''),
       latitude=nullif(p_data->>'latitude','')::double precision,longitude=nullif(p_data->>'longitude','')::double precision where id=facility and not is_demo;
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
   if facility is null and r.claim_external_id is not null then
     select id into facility from public.facilities where external_place_id=r.claim_external_id;
   end if;
   if facility is null then
     if exists(select 1 from public.facilities where not is_demo
       and lower(trim(name))=lower(trim(r.facility_name)) and lower(trim(address))=lower(trim(r.profile->>'address'))) then
       raise exception 'A matching directory listing already exists. Link it before approval.';
     end if;
     facility:=coalesce(replace(replace(r.claim_external_id,':','-'),'/','-'),'provider-'||rid::text);
     insert into public.facilities(id,name,type,area,address,hours,latitude,longitude,contact,directory_only,external_place_id)
     values(facility,r.facility_name,r.profile->>'type',r.profile->>'area',r.profile->>'address',r.profile->>'hours',
       (r.profile->>'latitude')::double precision,(r.profile->>'longitude')::double precision,r.phone,true,r.claim_external_id);
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
commit;