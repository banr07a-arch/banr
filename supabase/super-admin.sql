begin;
create table banr_private.super_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table banr_private.app_content (
  key text primary key check (key in ('patient','provider')),
  value jsonb not null check (jsonb_typeof(value) = 'object' and octet_length(value::text) <= 49152)
);
alter table banr_private.super_admins enable row level security;
alter table banr_private.app_content enable row level security;
revoke all on banr_private.super_admins, banr_private.app_content from public, anon, authenticated;

create function public.banr_app_content(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select value from banr_private.app_content where key=p_key
    and (key='patient' or exists(select 1 from banr_private.provider_staff where user_id=auth.uid())
      or exists(select 1 from banr_private.super_admins where user_id=auth.uid()))
  ), '{}'::jsonb);
$$;

create function public.banr_admin(p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  staff_id uuid;
  staff_email text;
  facility text;
  content_key text;
  content_value jsonb;
begin
  if not exists(select 1 from banr_private.super_admins where user_id=auth.uid()) then
    raise exception 'Super Admin access required.' using errcode='42501';
  end if;
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
  when 'load' then
    return jsonb_build_object(
      'facilities',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]'::jsonb) from public.facilities),
      'staff',(select coalesce(jsonb_agg(jsonb_build_object('email',u.email,'facility',f.name) order by f.name,u.email),'[]'::jsonb)
        from banr_private.provider_staff s join auth.users u on u.id=s.user_id join public.facilities f on f.id=s.facility_id));
  else raise exception 'Unknown admin action.';
  end case;
end;
$$;
revoke execute on function public.banr_app_content(text), public.banr_admin(text,jsonb) from public, anon, authenticated;
grant execute on function public.banr_app_content(text) to anon, authenticated;
grant execute on function public.banr_admin(text,jsonb) to authenticated;
commit;
