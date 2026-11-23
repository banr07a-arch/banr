begin;

create or replace function banr_private.book_session(p_session uuid, p_name text, p_age integer, p_sex text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  patient uuid := auth.uid();
  verified_phone text;
  session_row public.opd_sessions%rowtype;
  booking_id uuid;
  new_token integer;
begin
  select case when phone_confirmed_at is not null then '+' || ltrim(phone, '+') end
    into verified_phone
    from auth.users
    where id = patient and (email_confirmed_at is not null or phone_confirmed_at is not null);
  if not found then
    raise exception 'Verify your account before booking.';
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

create or replace function banr_private.my_appointments()
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
  join auth.users u on u.id = auth.uid()
    and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
  where a.patient_id = u.id or (a.source = 'walkin' and u.phone_confirmed_at is not null and a.walkin_phone = '+' || ltrim(u.phone, '+'))
  order by s.starts_at desc, a.token;
$$;

commit;
