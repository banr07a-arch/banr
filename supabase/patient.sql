begin;

create schema banr_private;
revoke all on schema banr_private from public;
grant usage on schema banr_private to authenticated;

create table public.facilities (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  name text not null,
  type text not null check (type in ('Clinic','Hospital')),
  area text not null,
  address text not null,
  hours text not null,
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180)
);

create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  facility_id text not null references public.facilities(id),
  name text not null,
  specialty text not null,
  fee integer not null check (fee >= 0)
);
create index doctors_facility_id on public.doctors(facility_id);

create table public.opd_sessions (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id),
  name text not null check (name in ('Morning','Evening')),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  capacity integer not null check (capacity > 0),
  booked_count integer not null default 0 check (booked_count between 0 and capacity),
  last_token integer not null default 0 check (last_token >= 0),
  current_token integer not null default 0 check (current_token between 0 and last_token),
  current_started_at timestamptz,
  consultation_minutes integer not null check (consultation_minutes > 0),
  status text not null default 'scheduled' check (status in ('scheduled','late','open','paused','closed')),
  revised_start_at timestamptz,
  unique (doctor_id, starts_at)
);

create table public.patient_profiles (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  age integer not null check (age between 0 and 120),
  sex text not null check (sex in ('Female','Male','Intersex','Prefer not to say'))
);

create table banr_private.appointments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.opd_sessions(id),
  patient_id uuid references auth.users(id) on delete set null,
  walkin_phone text check (walkin_phone ~ '^\+[1-9][0-9]{7,14}$'),
  token integer not null check (token > 0),
  source text not null check (source in ('online','walkin')),
  status text not null default 'waiting' check (status in ('waiting','serving','completed','no_show','cancelled')),
  unique (session_id, token),
  unique (session_id, patient_id),
  check ((source = 'walkin') = (walkin_phone is not null))
);
create index appointment_owner on banr_private.appointments(patient_id);
create index appointment_walkin on banr_private.appointments(walkin_phone) where source = 'walkin';

alter table public.facilities enable row level security;
alter table public.doctors enable row level security;
alter table public.opd_sessions enable row level security;
alter table public.patient_profiles enable row level security;
alter table banr_private.appointments enable row level security;
revoke all on public.facilities, public.doctors, public.opd_sessions, public.patient_profiles from public, anon, authenticated;
grant select on public.facilities, public.doctors, public.opd_sessions to anon, authenticated;
grant select, insert, update on public.patient_profiles to authenticated;

create policy facilities_catalog on public.facilities for select to anon, authenticated using (true);
create policy doctors_catalog on public.doctors for select to anon, authenticated using (true);
create policy opd_catalog on public.opd_sessions for select to anon, authenticated using (true);
create policy patient_profile_read on public.patient_profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy patient_profile_insert on public.patient_profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy patient_profile_update on public.patient_profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create function banr_private.book_session(p_session uuid, p_name text, p_age integer, p_sex text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  patient uuid := auth.uid();
  verified_phone text;
  session_row public.opd_sessions%rowtype;
  booking_id uuid;
  new_token integer;
begin
  select '+' || ltrim(phone, '+') into verified_phone
    from auth.users where id = patient and phone_confirmed_at is not null;
  if verified_phone is null then
    raise exception 'Verify your mobile number before booking.';
  end if;

  select * into session_row from public.opd_sessions where id = p_session for update;
  if not found then raise exception 'Session unavailable.'; end if;

  select id into booking_id from banr_private.appointments
  where session_id = p_session and (patient_id = patient or walkin_phone = verified_phone)
  order by token limit 1;
  if found then return booking_id; end if;

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
$$;

create function banr_private.my_appointments()
returns table (
  id uuid, facility text, facility_name text, doctor text, session_name text,
  starts_at timestamptz, ends_at timestamptz, revised_start_at timestamptz, token integer,
  current_token integer, patients_ahead integer, consultation_minutes integer,
  current_started_at timestamptz, source text, status text, opd_status text
)
language sql stable security definer set search_path = '' as $$
  select a.id, f.id, f.name, d.name, s.name, s.starts_at, s.ends_at, s.revised_start_at,
    a.token, s.current_token,
    (select count(*)::integer from banr_private.appointments q
     where q.session_id = s.id and q.token > s.current_token and q.token < a.token and q.status = 'waiting'),
    s.consultation_minutes, s.current_started_at, a.source, a.status, s.status
  from banr_private.appointments a
  join public.opd_sessions s on s.id = a.session_id
  join public.doctors d on d.id = s.doctor_id
  join public.facilities f on f.id = d.facility_id
  join auth.users u on u.id = auth.uid() and u.phone_confirmed_at is not null
  where a.patient_id = u.id or (a.source = 'walkin' and a.walkin_phone = '+' || ltrim(u.phone, '+'))
  order by s.starts_at desc, a.token;
$$;

create function public.banr_book_session(p_session uuid, p_name text, p_age integer, p_sex text)
returns uuid language sql security invoker set search_path = '' as $$
  select banr_private.book_session(p_session, p_name, p_age, p_sex);
$$;
create function public.banr_my_appointments()
returns table (
  id uuid, facility text, facility_name text, doctor text, session_name text,
  starts_at timestamptz, ends_at timestamptz, revised_start_at timestamptz, token integer,
  current_token integer, patients_ahead integer, consultation_minutes integer,
  current_started_at timestamptz, source text, status text, opd_status text
)
language sql stable security invoker set search_path = '' as $$
  select * from banr_private.my_appointments();
$$;

revoke execute on all functions in schema banr_private from public, anon;
revoke execute on function public.banr_book_session(uuid,text,integer,text), public.banr_my_appointments() from public, anon;
grant execute on function banr_private.book_session(uuid,text,integer,text), banr_private.my_appointments(),
  public.banr_book_session(uuid,text,integer,text), public.banr_my_appointments() to authenticated;

commit;
