begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('banr-banner-assets','banr-banner-assets',true,5242880,array['image/jpeg','image/png','image/webp']);
create function public.banr_banner_upload_authorized(p_token text)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(p_token ~ '^[a-f0-9]{64}$',false) and exists (
   select 1 from banr_private.admin_sessions
   where token_hash=extensions.digest(p_token,'sha256') and expires_at>now()
 );
$$;
revoke execute on function public.banr_banner_upload_authorized(text) from public,anon,authenticated;
grant execute on function public.banr_banner_upload_authorized(text) to service_role;
commit;