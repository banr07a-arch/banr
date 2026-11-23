begin;

create or replace function public.banr_provider_delete_doctor(p_facility text, p_doctor uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from banr_private.provider_staff
    where facility_id = p_facility and user_id = auth.uid()
  ) then
    raise exception 'Facility access required.';
  end if;

  delete from public.doctors where id = p_doctor and facility_id = p_facility;
  if not found then raise exception 'Doctor not found.'; end if;
exception
  when foreign_key_violation then
    raise exception 'Doctors with OPD sessions cannot be deleted.';
end;
$$;

revoke execute on function public.banr_provider_delete_doctor(text, uuid) from public, anon;
grant execute on function public.banr_provider_delete_doctor(text, uuid) to authenticated;

commit;
