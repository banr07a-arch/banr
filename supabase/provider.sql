begin;

alter table public.facilities add column if not exists contact text;
alter table public.doctors add column if not exists consultation_minutes integer not null default 10
  check (consultation_minutes between 1 and 180);
alter table banr_private.appointments
  add column if not exists walkin_name text,
  add column if not exists walkin_age integer,
  add column if not exists walkin_sex text;

create table if not exists banr_private.provider_staff (
  user_id uuid not null references auth.users(id) on delete cascade,
  facility_id text not null references public.facilities(id) on delete cascade,
  primary key(user_id, facility_id)
);
alter table banr_private.provider_staff enable row level security;
revoke all on banr_private.provider_staff from public, anon, authenticated;

create or replace function public.banr_provider_facilities()
returns setof public.facilities language sql stable security definer set search_path = '' as $$
  select f.* from public.facilities f
  join banr_private.provider_staff staff on staff.facility_id=f.id
  where staff.user_id=auth.uid() order by f.name;
$$;

create or replace function public.banr_provider_manage(p_facility text, p_action text, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  doctor_id_arg uuid := (p_data->>'doctor_id')::uuid;
  session_id_arg uuid := (p_data->>'session_id')::uuid;
  consultation integer;
  starts timestamptz;
  ends timestamptz;
  limit_count integer;
begin
  if not exists(select 1 from banr_private.provider_staff where facility_id=p_facility and user_id=auth.uid()) then
    raise exception 'Facility access required.';
  end if;

  case p_action
  when 'facility' then
    update public.facilities set
      name=nullif(btrim(p_data->>'name'),''),
      area=nullif(btrim(p_data->>'area'),''),
      address=nullif(btrim(p_data->>'address'),''),
      hours=nullif(btrim(p_data->>'hours'),''),
      contact=nullif(btrim(p_data->>'contact'),'')
    where id=p_facility;
  when 'doctor' then
    if doctor_id_arg is null then
      insert into public.doctors(facility_id,name,specialty,fee,consultation_minutes)
      values(p_facility,nullif(btrim(p_data->>'name'),''),nullif(btrim(p_data->>'specialty'),''),
        (p_data->>'fee')::integer,(p_data->>'consultation_minutes')::integer);
    else
      update public.doctors set name=nullif(btrim(p_data->>'name'),''),
        specialty=nullif(btrim(p_data->>'specialty'),''),fee=(p_data->>'fee')::integer,
        consultation_minutes=(p_data->>'consultation_minutes')::integer
      where id=doctor_id_arg and facility_id=p_facility;
      if not found then raise exception 'Doctor not found.'; end if;
    end if;
  when 'session' then
    select consultation_minutes into consultation from public.doctors
      where id=doctor_id_arg and facility_id=p_facility;
    if not found then raise exception 'Doctor not found.'; end if;
    starts := (p_data->>'starts_at')::timestamptz;
    ends := (p_data->>'ends_at')::timestamptz;
    limit_count := (p_data->>'capacity')::integer;
    if starts is null or ends is null or ends <= greatest(starts,now()) then
      raise exception 'Choose an end time after the start and current time.';
    end if;
    if limit_count is null or limit_count < 1 then raise exception 'Enter a valid appointment limit.'; end if;
    if session_id_arg is null then
      insert into public.opd_sessions(doctor_id,name,starts_at,ends_at,capacity,consultation_minutes)
      values(doctor_id_arg,p_data->>'name',starts,ends,limit_count,consultation);
    else
      update public.opd_sessions set name=p_data->>'name',starts_at=starts,ends_at=ends,capacity=limit_count
      where id=session_id_arg and doctor_id=doctor_id_arg and status in ('scheduled','late')
        and starts_at>now() and booked_count=0;
      if not found then raise exception 'Only upcoming sessions without bookings can be rescheduled.'; end if;
    end if;
  else raise exception 'Unknown settings action.';
  end case;
end;
$$;

create or replace function public.banr_provider_queue(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'status',s.status,'current_token',s.current_token,'booked_count',s.booked_count,
    'capacity',s.capacity,'revised_start_at',s.revised_start_at,
    'serving',exists(select 1 from banr_private.appointments a where a.session_id=s.id and a.status='serving'),
    'waiting',(select count(*) from banr_private.appointments a where a.session_id=s.id and a.status='waiting')
  ) into result
  from public.opd_sessions s join public.doctors d on d.id=s.doctor_id
  join banr_private.provider_staff staff on staff.facility_id=d.facility_id and staff.user_id=auth.uid()
  where s.id=p_session;
  if not found then raise exception 'Session access required.'; end if;
  return result;
end;
$$;

create or replace function public.banr_provider_action(
  p_session uuid,p_action text,p_expected_token integer,p_data jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.opd_sessions%rowtype;
  next_id uuid;
  next_token integer;
  phone_arg text;
  name_arg text;
  age_arg integer;
  sex_arg text;
  revised timestamptz;
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
    revised := (p_data->>'revised_start_at')::timestamptz;
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
    update public.opd_sessions set status='closed',current_started_at=null where id=s.id;
  when 'start','next','no_show' then
    if p_action='start' and (s.status not in ('scheduled','late') or s.ends_at<=now()) then
      raise exception 'This OPD cannot be started.';
    elsif p_action<>'start' and s.status<>'open' then
      raise exception 'Start or resume OPD first.';
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
      current_started_at=case when next_token is null then null else now() end where id=s.id;
  else raise exception 'Unknown queue action.';
  end case;
  return public.banr_provider_queue(s.id)||jsonb_build_object('walkin',walkin_result);
end;
$$;

revoke execute on function public.banr_provider_facilities(), public.banr_provider_manage(text,text,jsonb),
  public.banr_provider_queue(uuid), public.banr_provider_action(uuid,text,integer,jsonb) from public, anon;
grant execute on function public.banr_provider_facilities(), public.banr_provider_manage(text,text,jsonb),
  public.banr_provider_queue(uuid), public.banr_provider_action(uuid,text,integer,jsonb) to authenticated;
commit;
