begin;
alter table public.facilities add column if not exists directory_only boolean not null default false,
  add column if not exists maps_url text;
insert into public.facilities(id,name,type,area,address,hours,contact,directory_only,maps_url)
values('elixir-clinic-mumbra','Dr Suhail ELIXIR CLINIC','Clinic','Kausa, Mumbra',
'No. 1/A, Pleasure Gardens, Talao Pali Road, near Love Selfie Point, Kausa, Mumbra, Thane, Maharashtra 400612',
'Call clinic to confirm hours','+91 99203 77380',true,
'https://maps.google.com/maps?ftid=0x3be7bf7256cf01ff:0x70d0e6bb66cd0a35')
on conflict(id) do nothing;
commit;