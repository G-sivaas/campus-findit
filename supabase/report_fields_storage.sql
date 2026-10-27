-- Campus FindIt reference fields and private photo uploads
-- Run after supabase/schema.sql and supabase/advanced_features.sql.
-- This migration keeps existing reports, then adds the fields used by the mobile reference page.

begin;

alter table public.campus_items
  add column if not exists item_type text not null default '',
  add column if not exists brand text,
  add column if not exists color text,
  add column if not exists report_date date not null default current_date,
  add column if not exists approximate_time time,
  add column if not exists location_id text not null default 'other',
  add column if not exists value_classification text not null default 'Less expensive',
  add column if not exists handling text not null default '',
  add column if not exists approved boolean not null default true,
  add column if not exists review_status text not null default 'approved',
  add column if not exists photo_path text;

update public.campus_items
set item_type = coalesce(nullif(item_type, ''), item_name),
    location_id = case
      when location ilike '%gate%' or location ilike '%security%' or location ilike '%CSE%'
        or location ilike '%Science Block%' or location ilike '%Administration%' then 'west'
      when location ilike '%East%' or location ilike '%EEE%' or location ilike '%Physics%'
        or location ilike '%Canteen%' or location ilike '%Playground%' or location ilike '%Bus%'
        then 'east'
      when location ilike '%Library%' or location ilike '%Reading%' or location ilike '%Garden%'
        or location ilike '%Auditorium%' or location ilike '%Water%' then 'central'
      else location_id
    end;

alter table public.campus_items drop constraint if exists campus_items_category_check;
alter table public.campus_items add constraint campus_items_category_check check (
  category in (
    'ID cards','Books & notebooks','Bags','Wallets','Earphones','Electronic devices',
    'Keys','Watches & accessories','Water bottles','Stationery','Clothing','Other',
    'ID Card','Wallet','Books','Electronics'
  )
);
alter table public.campus_items drop constraint if exists campus_items_review_status_check;
alter table public.campus_items add constraint campus_items_review_status_check
  check (review_status in ('pending','approved','rejected'));
alter table public.campus_items drop constraint if exists campus_items_value_classification_check;
alter table public.campus_items add constraint campus_items_value_classification_check
  check (value_classification in ('Less expensive','Expensive'));
alter table public.campus_items drop constraint if exists campus_items_location_id_check;
alter table public.campus_items add constraint campus_items_location_id_check check (
  location_id in (
    'gate-main','gate-east','security','cse','ece','eee','science','lab','physics',
    'library','reading','canteen','admin','auditorium','playground','garden','bike','bus','water',
    'west','central','east','other'
  )
);

alter table public.campus_item_private
  add column if not exists private_clue text,
  add column if not exists location_detail text;

-- Students cannot publish found reports by setting approval fields themselves.
create or replace function public.set_campus_item_review_state()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'found' then
    new.approved := false;
    new.review_status := 'pending';
  else
    new.approved := true;
    new.review_status := 'approved';
  end if;
  return new;
end;
$$;
drop trigger if exists campus_items_review_state_on_insert on public.campus_items;
create trigger campus_items_review_state_on_insert
before insert on public.campus_items
for each row execute function public.set_campus_item_review_state();

drop policy if exists "Verified users create their own items" on public.campus_items;
create policy "Verified users create their own items"
on public.campus_items for insert to authenticated
with check (
  public.is_verified_campus_user()
  and owner_id = (select auth.uid())
  and (
    (status = 'lost' and approved and review_status = 'approved')
    or (status = 'found' and not approved and review_status = 'pending')
  )
);

create index if not exists campus_items_report_date_idx
  on public.campus_items (report_date desc);
create index if not exists campus_items_status_approved_idx
  on public.campus_items (status, approved, resolved, created_at desc);

-- Owners and staff see private item rows; other verified students use the masked view below.
grant select (
  id,owner_id,item_name,category,status,location,description,image_url,resolved,created_at,
  item_type,brand,color,report_date,approximate_time,location_id,value_classification,
  handling,approved,review_status,photo_path
) on public.campus_items to authenticated;
grant insert (
  id,owner_id,item_name,category,status,location,description,image_url,item_type,brand,color,
  report_date,approximate_time,location_id,value_classification,handling,photo_path
) on public.campus_items to authenticated;
grant update (resolved) on public.campus_items to authenticated;
grant select (item_id,owner_id,contact_info,created_at,private_clue,location_detail)
  on public.campus_item_private to authenticated;
grant insert (item_id,owner_id,contact_info,private_clue,location_detail)
  on public.campus_item_private to authenticated;

-- Staff approval is exposed only through a checked function, never direct column updates.
create or replace function public.review_campus_found_report(p_item_id uuid, p_approved boolean)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_verified_campus_user() or not public.is_campus_staff() then
    raise exception 'Only verified campus staff can review found reports.';
  end if;
  update public.campus_items
  set approved = p_approved,
      review_status = case when p_approved then 'approved' else 'rejected' end
  where id = p_item_id and status = 'found' and not resolved;
  if not found then
    raise exception 'The found report is missing or already resolved.';
  end if;
end;
$$;
revoke all on function public.review_campus_found_report(uuid,boolean) from public, anon;
grant execute on function public.review_campus_found_report(uuid,boolean) to authenticated;

drop policy if exists "Owners and staff read private report details" on public.campus_item_private;
create policy "Owners and staff read private report details"
on public.campus_item_private for select to authenticated
using (
  public.is_verified_campus_user()
  and (owner_id = (select auth.uid()) or public.is_campus_staff())
);

-- Keep the existing public view's first eleven columns stable; append the reference fields.
create or replace view public.campus_items_public
with (security_barrier = true)
as
select
  i.id,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.owner_id
       else null end as owner_id,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.item_name
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then 'Restricted item' else i.item_name end as item_name,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.category
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then 'Restricted item' else i.category end as category,
  i.status,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.location
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then 'Broad campus area shared after verification'
       else case
         when i.location_id in ('gate-main','security','cse','science','admin','bike','west') then 'West campus'
         when i.location_id in ('gate-east','eee','physics','canteen','playground','bus','east') then 'East campus'
         when i.location_id in ('ece','lab','library','reading','auditorium','garden','water','central') then 'Central campus'
         else 'Other campus area' end
  end as location,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.description
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then 'A restricted item has been reported. Send a private claim to verify ownership.'
       else i.description end as description,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.image_url
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then null else i.image_url end as image_url,
  i.resolved,
  i.created_at,
  case
    when i.location_id in ('gate-main','security','cse','science','admin','bike','west') then 'West campus'
    when i.location_id in ('gate-east','eee','physics','canteen','playground','bus','east') then 'East campus'
    when i.location_id in ('ece','lab','library','reading','auditorium','garden','water','central') then 'Central campus'
    else 'Other campus area'
  end as zone_name,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.item_type
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then 'Restricted item' else i.item_type end as item_type,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.brand
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then null else i.brand end as brand,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.color
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then null else i.color end as color,
  i.report_date,
  i.approximate_time,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff() then i.photo_path
       when (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
         or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
       then null else i.photo_path end as photo_path,
  i.approved,
  i.review_status
from public.campus_items i
where public.is_verified_campus_user()
  and (not i.resolved or i.owner_id = (select auth.uid()) or public.is_campus_staff())
  and (i.status = 'lost' or i.approved or i.owner_id = (select auth.uid()) or public.is_campus_staff());

revoke all on public.campus_items_public from public, anon, authenticated;
grant select on public.campus_items_public to authenticated;

-- Photos are private by default. Only owners/staff and verified users viewing an
-- approved, non-sensitive report can receive a signed link.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('campus-item-photos', 'campus-item-photos', false, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "Campus FindIt owners upload their photos" on storage.objects;
create policy "Campus FindIt owners upload their photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'campus-item-photos'
  and public.is_verified_campus_user()
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.campus_items i
    where i.id::text = (storage.foldername(name))[2]
      and i.owner_id = (select auth.uid())
  )
);

create or replace function public.can_view_campus_photo(p_owner_path text, p_item_path text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_verified_campus_user() and exists (
    select 1
    from public.campus_items i
    where i.id::text = p_item_path
      and i.owner_id::text = p_owner_path
      and (
        i.owner_id = (select auth.uid())
        or public.is_campus_staff()
        or (
          not (i.category in ('ID cards','ID Card','Wallets','Wallet','Electronic devices','Electronics','Keys','Watches & accessories')
            or i.item_type ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry|jewellery)')
          and not i.resolved
          and (i.status = 'lost' or i.approved)
        )
      )
  );
$$;
revoke all on function public.can_view_campus_photo(text,text) from public, anon;
grant execute on function public.can_view_campus_photo(text,text) to authenticated;

drop policy if exists "Campus FindIt report viewers read permitted photos" on storage.objects;
create policy "Campus FindIt report viewers read permitted photos"
on storage.objects for select to authenticated
using (
  bucket_id = 'campus-item-photos'
  and public.can_view_campus_photo(
    (storage.foldername(name))[1], (storage.foldername(name))[2]
  )
);

drop policy if exists "Campus FindIt owners remove their photos" on storage.objects;
create policy "Campus FindIt owners remove their photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'campus-item-photos'
  and public.is_verified_campus_user()
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

commit;
