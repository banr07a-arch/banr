begin;
create table banr_private.admin_accounts (
  username text primary key check (username ~ '^[a-z0-9][a-z0-9_-]{2,31}$'),
  password_hash text,
  setup_hash bytea,
  setup_expires timestamptz,
  failures integer not null default 0,
  blocked_until timestamptz
);
create table banr_private.admin_sessions (
  token_hash bytea primary key,
  username text not null references banr_private.admin_accounts on delete cascade,
  expires_at timestamptz not null
);
alter table banr_private.admin_accounts enable row level security;
alter table banr_private.admin_sessions enable row level security;
revoke all on banr_private.admin_accounts, banr_private.admin_sessions from public, anon, authenticated;

create function banr_private.username_admin_action(p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  staff_id uuid;
  staff_email text;
  facility text;
  content_key text;
  content_value jsonb;
begin
  case p_action
  when 'save_content' then
    content_key := p_data->>'key';
    content_value := p_data->'value';
    if content_key is null or content_key not in ('patient','provider') or jsonb_typeof(content_value) is distinct from 'object' then
      raise exception 'Invalid content.';
    end if;
    if content_key='patient' then
      select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) into content_value
      from jsonb_each(content_value) as entry(k,v)
      where k in ('subtitle','supportEmail','refundTerms','promotions','expertAnswers','helpFAQs','privacySections','hero','about');
      if jsonb_typeof(content_value->'expertAnswers') = 'array' then
        content_value := jsonb_set(content_value, '{expertAnswers}', (
          select coalesce(jsonb_agg(item order by ord),'[]'::jsonb)
          from jsonb_array_elements(content_value->'expertAnswers') with ordinality as items(item,ord)
          where item->'review'->>'status'='reviewed' and item->'review'->'verified'='true'::jsonb
        ));
      end if;
    else
      select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) into content_value
      from jsonb_each(content_value) as entry(k,v) where k in ('subtitle','notice');
    end if;
    insert into banr_private.app_content(key,value) values(content_key,content_value)
    on conflict(key) do update set value=excluded.value;
    return content_value;
  when 'grant_staff', 'revoke_staff' then
    staff_email := lower(btrim(p_data->>'email'));
    facility := p_data->>'facility';
    select id into staff_id from auth.users where lower(email)=staff_email and email_confirmed_at is not null;
    if staff_id is null then raise exception 'Create and confirm this staff login in Supabase first.'; end if;
    if not exists(select 1 from public.facilities where id=facility) then raise exception 'Select a valid clinic or hospital.'; end if;
    if p_action='grant_staff' then
      insert into banr_private.provider_staff(user_id,facility_id) values(staff_id,facility) on conflict do nothing;
    else
      delete from banr_private.provider_staff where user_id=staff_id and facility_id=facility;
    end if;
    return jsonb_build_object('ok',true);
  when 'content' then
    return coalesce((select value from banr_private.app_content where key=p_data->>'key'),'{}'::jsonb);
  when 'load' then
    return jsonb_build_object(
      'facilities',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]'::jsonb) from public.facilities),
      'staff',(select coalesce(jsonb_agg(jsonb_build_object('email',u.email,'facility',f.name) order by f.name,u.email),'[]'::jsonb)
        from banr_private.provider_staff s join auth.users u on u.id=s.user_id join public.facilities f on f.id=s.facility_id));
  else raise exception 'Unknown admin action.';
  end case;
end;
$$;

revoke execute on function banr_private.username_admin_action(text,jsonb) from public, anon, authenticated;

create or replace function public.banr_admin(p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $
begin
  if not exists(select 1 from banr_private.super_admins where user_id=auth.uid()) then
    raise exception 'Super Admin access required.' using errcode='42501';
  end if;
  return banr_private.username_admin_action(p_action,p_data);
end;
$;

create function public.banr_admin_credentials(p_username text,p_password text,p_setup text default null)
returns text language plpgsql security definer set search_path='' as $$
declare
  account banr_private.admin_accounts%rowtype;
  token text;
begin
  if p_username is null or p_password is null or octet_length(p_password) not between 12 and 72 then return null; end if;
  select * into account from banr_private.admin_accounts where username=lower(trim(p_username)) for update;
  if not found or account.blocked_until > now() then return null; end if;
  if account.password_hash is null and p_setup is not null and account.setup_expires > now()
    and account.setup_hash=extensions.digest(p_setup,'sha256') then
    update banr_private.admin_accounts set password_hash=extensions.crypt(p_password,extensions.gen_salt('bf',12)),
      setup_hash=null,setup_expires=null where username=account.username;
  elsif p_setup is not null or account.password_hash is null or
    extensions.crypt(p_password,account.password_hash) is distinct from account.password_hash then
    update banr_private.admin_accounts set
      failures=case when failures>=4 then 0 else failures+1 end,
      blocked_until=case when failures>=4 then now()+interval '5 minutes' else null end
      where username=account.username;
    return null;
  end if;
  update banr_private.admin_accounts set failures=0,blocked_until=null where username=account.username;
  delete from banr_private.admin_sessions where username=account.username and expires_at<=now();
  token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into banr_private.admin_sessions values(extensions.digest(token,'sha256'),account.username,now()+interval '8 hours');
  return token;
end;
$$;

create function public.banr_admin_session(p_token text,p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare token_hash_arg bytea;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Super Admin sign-in required.' using errcode='42501'; end if;
  token_hash_arg:=extensions.digest(p_token,'sha256');
  if not exists(select 1 from banr_private.admin_sessions where token_hash=token_hash_arg and expires_at>now()) then
    raise exception 'Super Admin sign-in required.' using errcode='42501';
  end if;
  if p_action='signout' then
    delete from banr_private.admin_sessions where token_hash=token_hash_arg;
    return '{}'::jsonb;
  end if;
  return banr_private.username_admin_action(p_action,p_data);
end;
$$;
revoke execute on function public.banr_admin_credentials(text,text,text),public.banr_admin_session(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.banr_admin_credentials(text,text,text),public.banr_admin_session(text,text,jsonb) to anon;
commit;