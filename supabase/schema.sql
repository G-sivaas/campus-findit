-- Campus FindIt Supabase schema
-- Run the whole file in Supabase Dashboard > SQL Editor.
-- Supabase Auth must require/confirm email addresses before production use.
-- To restrict signup to a campus domain, add an email-domain condition in
-- is_verified_campus_user() below (replace your-campus.edu with the real domain).

create extension if not exists pgcrypto;

create or replace function public.is_verified_campus_user()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from auth.users u
    where u.id = (select auth.uid())
      and u.email_confirmed_at is not null
      -- Optional campus-only check:
      -- and lower(u.email) like '%@your-campus.edu'
  );
$$;

revoke all on function public.is_verified_campus_user() from public, anon;
grant execute on function public.is_verified_campus_user() to authenticated;

create table if not exists public.campus_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_name text not null check (char_length(item_name) between 2 and 80),
  item_type text not null default '',
  brand text,
  color text,
  report_date date not null default current_date,
  approximate_time time,
  location_id text not null default 'other',
  value_classification text not null default 'Less expensive' check (value_classification in ('Less expensive','Expensive')),
  handling text not null default '',
  approved boolean not null default true,
  review_status text not null default 'approved' check (review_status in ('pending','approved','rejected')),
  photo_path text,
  category text not null check (category in ('ID cards','Books & notebooks','Bags','Wallets','Earphones','Electronic devices','Keys','Watches & accessories','Water bottles','Stationery','Clothing','Other','ID Card','Wallet','Books','Electronics')),
  status text not null check (status in ('lost','found')),
  location text not null check (char_length(location) between 2 and 120),
  description text not null check (char_length(description) between 3 and 700),
  image_url text check (image_url is null or (image_url like 'https://%' and char_length(image_url) <= 2000)),
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- Contact details never appear on public listings.
create table if not exists public.campus_item_private (
  item_id uuid primary key references public.campus_items(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  contact_info text not null check (char_length(contact_info) between 3 and 160),
  private_clue text,
  location_detail text,
  created_at timestamptz not null default now()
);

-- Private owner/claimant conversation used to coordinate a safe handoff.
create table if not exists public.campus_claims (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.campus_items(id) on delete cascade,
  claimant_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ownership_proof text not null check (char_length(ownership_proof) between 3 and 250),
  message text not null default '' check (char_length(message) <= 500),
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  owner_response text not null default '' check (char_length(owner_response) <= 500),
  created_at timestamptz not null default now(),
  unique (item_id, claimant_id)
);

create index if not exists campus_items_open_created_idx
  on public.campus_items (resolved, created_at desc);
create index if not exists campus_items_owner_created_idx
  on public.campus_items (owner_id, created_at desc);
create index if not exists campus_claims_claimant_created_idx
  on public.campus_claims (claimant_id, created_at desc);
create index if not exists campus_claims_item_created_idx
  on public.campus_claims (item_id, created_at desc);

alter table public.campus_items enable row level security;
alter table public.campus_item_private enable row level security;
alter table public.campus_claims enable row level security;

revoke all on table public.campus_items from anon, authenticated;
revoke all on table public.campus_item_private from anon, authenticated;
revoke all on table public.campus_claims from anon, authenticated;

grant select (id, owner_id, item_name, category, status, location, description, image_url, resolved, created_at)
  on public.campus_items to authenticated;
grant insert (owner_id, item_name, category, status, location, description, image_url)
  on public.campus_items to authenticated;
grant update (resolved) on public.campus_items to authenticated;
grant delete on public.campus_items to authenticated;

grant select (item_id, owner_id, contact_info, created_at)
  on public.campus_item_private to authenticated;
grant insert (item_id, owner_id, contact_info)
  on public.campus_item_private to authenticated;

grant select (id, item_id, claimant_id, ownership_proof, message, status, owner_response, created_at)
  on public.campus_claims to authenticated;
grant insert (item_id, claimant_id, ownership_proof, message)
  on public.campus_claims to authenticated;
grant update (status, owner_response) on public.campus_claims to authenticated;

drop policy if exists "Verified users browse open campus items" on public.campus_items;
create policy "Verified users browse open campus items"
on public.campus_items for select to authenticated
using (
  public.is_verified_campus_user()
  and (not resolved or owner_id = (select auth.uid()))
);

drop policy if exists "Verified users create their own items" on public.campus_items;
create policy "Verified users create their own items"
on public.campus_items for insert to authenticated
with check (
  public.is_verified_campus_user()
  and owner_id = (select auth.uid())
);

drop policy if exists "Owners resolve their own items" on public.campus_items;
create policy "Owners resolve their own items"
on public.campus_items for update to authenticated
using (owner_id = (select auth.uid()) and public.is_verified_campus_user())
with check (owner_id = (select auth.uid()));

drop policy if exists "Owners delete their own items" on public.campus_items;
create policy "Owners delete their own items"
on public.campus_items for delete to authenticated
using (owner_id = (select auth.uid()) and public.is_verified_campus_user());

drop policy if exists "Owners see private contact details" on public.campus_item_private;
create policy "Owners see private contact details"
on public.campus_item_private for select to authenticated
using (owner_id = (select auth.uid()) and public.is_verified_campus_user());

drop policy if exists "Owners add private contact details" on public.campus_item_private;
create policy "Owners add private contact details"
on public.campus_item_private for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and public.is_verified_campus_user()
  and exists (
    select 1 from public.campus_items i
    where i.id = item_id and i.owner_id = (select auth.uid())
  )
);

drop policy if exists "Claimants and item owners read claim requests" on public.campus_claims;
create policy "Claimants and item owners read claim requests"
on public.campus_claims for select to authenticated
using (
  public.is_verified_campus_user()
  and (
    claimant_id = (select auth.uid())
    or exists (
      select 1 from public.campus_items i
      where i.id = item_id and i.owner_id = (select auth.uid())
    )
  )
);

drop policy if exists "Verified users submit one claim per item" on public.campus_claims;
create policy "Verified users submit one claim per item"
on public.campus_claims for insert to authenticated
with check (
  claimant_id = (select auth.uid())
  and public.is_verified_campus_user()
  and exists (
    select 1 from public.campus_items i
    where i.id = item_id
      and not i.resolved
      and i.owner_id <> (select auth.uid())
  )
);

drop policy if exists "Item owners respond to claims" on public.campus_claims;
create policy "Item owners respond to claims"
on public.campus_claims for update to authenticated
using (
  public.is_verified_campus_user()
  and exists (
    select 1 from public.campus_items i
    where i.id = item_id and i.owner_id = (select auth.uid())
  )
)
with check (
  status in ('pending','approved','declined')
  and exists (
    select 1 from public.campus_items i
    where i.id = item_id and i.owner_id = (select auth.uid())
  )
);
