-- Campus FindIt advanced features
-- Run once in Supabase Dashboard > SQL Editor, after schema.sql.
-- This adds private staff authorization, a privacy-filtered public listing,
-- broad campus zones, and a transaction-safe in-person handover workflow.

begin;

create table if not exists public.campus_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Campus staff',
  created_at timestamptz not null default now()
);
alter table public.campus_staff enable row level security;
revoke all on table public.campus_staff from public, anon, authenticated;

create or replace function public.is_campus_staff()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.campus_staff s
    where s.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_campus_staff() from public, anon;
grant execute on function public.is_campus_staff() to authenticated;

-- Students see full details only for their own reports; staff may review them.
drop policy if exists "Verified users browse open campus items" on public.campus_items;
drop policy if exists "Owners and staff read private item details" on public.campus_items;
create policy "Owners and staff read private item details"
on public.campus_items for select to authenticated
using (
  public.is_verified_campus_user()
  and (owner_id = (select auth.uid()) or public.is_campus_staff())
);

-- Other verified students use this view. Identity-bearing and valuable items
-- are shown only as generic reports, without photo, detailed text, or exact place.
create or replace view public.campus_items_public
with (security_barrier = true)
as
select
  i.id,
  i.owner_id,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff()
       then i.item_name
       when (i.category in ('ID Card','Wallet','Electronics','Keys') or i.item_name ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry)')
       then 'Restricted item'
       else i.item_name end as item_name,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff()
       then i.category
       when (i.category in ('ID Card','Wallet','Electronics','Keys') or i.item_name ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry)')
       then 'Restricted item'
       else i.category end as category,
  i.status,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff()
       then i.location
       when (i.category in ('ID Card','Wallet','Electronics','Keys') or i.item_name ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry)')
       then 'Broad campus area shared after verification'
       else i.location end as location,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff()
       then i.description
       when (i.category in ('ID Card','Wallet','Electronics','Keys') or i.item_name ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry)')
       then 'A restricted item has been reported. Send a private claim to verify ownership.'
       else i.description end as description,
  case when i.owner_id = (select auth.uid()) or public.is_campus_staff()
       then i.image_url
       when (i.category in ('ID Card','Wallet','Electronics','Keys') or i.item_name ~* '(passport|bank card|access card|phone|iphone|smartphone|laptop|tablet|jewelry)')
       then null
       else i.image_url end as image_url,
  i.resolved,
  i.created_at,
  case
    when i.location ilike '%Main Entrance%' or i.location ilike '%Security Checkpoint%'
      or i.location ilike '%CSE Block%' or i.location ilike '%Science Block%'
      or i.location ilike '%Administrative Office%' or i.location ilike '%Bike Parking%'
      then 'West campus'
    when i.location ilike '%East Gate%' or i.location ilike '%EEE Block%'
      or i.location ilike '%Physics Laboratory%' or i.location ilike '%Canteen%'
      or i.location ilike '%Playground%' or i.location ilike '%Bus Pickup%'
      then 'East campus'
    when i.location ilike '%campus%' then 'Central campus'
    else 'Other campus area'
  end as zone_name
from public.campus_items i
where public.is_verified_campus_user()
  and (not i.resolved or i.owner_id = (select auth.uid()) or public.is_campus_staff());

revoke all on public.campus_items_public from public, anon, authenticated;
grant select on public.campus_items_public to authenticated;

-- A claimant may claim only a found report, not a report saying they lost an item.
drop policy if exists "Verified users submit one claim per item" on public.campus_claims;
create policy "Verified users submit one claim per found item"
on public.campus_claims for insert to authenticated
with check (
  claimant_id = (select auth.uid())
  and public.is_verified_campus_user()
  and exists (
    select 1 from public.campus_items i
    where i.id = item_id
      and i.status = 'found'
      and not i.resolved
      and i.owner_id <> (select auth.uid())
  )
);

-- Authorized staff can review private claim evidence; students still see only
-- claims they submitted or claims on their own reports.
drop policy if exists "Claimants and item owners read claim requests" on public.campus_claims;
create policy "Claimants owners and staff read claim requests"
on public.campus_claims for select to authenticated
using (
  public.is_verified_campus_user()
  and (
    claimant_id = (select auth.uid())
    or public.is_campus_staff()
    or exists (
      select 1 from public.campus_items i
      where i.id = item_id and i.owner_id = (select auth.uid())
    )
  )
);

alter table public.campus_claims
  drop constraint if exists campus_claims_status_check;
alter table public.campus_claims
  add constraint campus_claims_status_check
  check (status in ('pending','approved','declined','handover_pending','recovered')) not valid;
alter table public.campus_claims
  validate constraint campus_claims_status_check;

create table if not exists public.campus_custody (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.campus_items(id) on delete cascade,
  claim_id uuid not null unique references public.campus_claims(id) on delete cascade,
  staff_id uuid not null references auth.users(id) on delete restrict,
  claimant_id uuid not null references auth.users(id) on delete cascade,
  identity_checked boolean not null default false,
  item_checked boolean not null default false,
  recipient_acknowledged boolean not null default false,
  status text not null default 'in_custody' check (status in ('in_custody','released')),
  created_at timestamptz not null default now(),
  handover_at timestamptz
);
create index if not exists campus_custody_status_created_idx
  on public.campus_custody (status, created_at desc);
alter table public.campus_custody enable row level security;
revoke all on public.campus_custody from public, anon, authenticated;
grant select on public.campus_custody to authenticated;
grant insert (item_id,claim_id,staff_id,claimant_id) on public.campus_custody to authenticated;
grant update (identity_checked,item_checked,recipient_acknowledged) on public.campus_custody to authenticated;

drop policy if exists "Campus staff create custody records" on public.campus_custody;
create policy "Campus staff create custody records"
on public.campus_custody for insert to authenticated
with check (
  public.is_verified_campus_user()
  and public.is_campus_staff()
  and staff_id = (select auth.uid())
  and exists (
    select 1 from public.campus_claims c
    join public.campus_items i on i.id = c.item_id
    where c.id = public.campus_custody.claim_id
      and c.item_id = public.campus_custody.item_id
      and c.claimant_id = public.campus_custody.claimant_id and c.status = 'approved'
      and i.status = 'found' and not i.resolved
  )
);
drop policy if exists "Campus staff update custody checks" on public.campus_custody;
create policy "Campus staff update custody checks"
on public.campus_custody for update to authenticated
using (public.is_verified_campus_user() and public.is_campus_staff() and staff_id = (select auth.uid()) and status = 'in_custody')
with check (public.is_verified_campus_user() and public.is_campus_staff() and staff_id = (select auth.uid()) and status = 'in_custody');
drop policy if exists "Participants and staff read custody records" on public.campus_custody;
create policy "Participants and staff read custody records"
on public.campus_custody for select to authenticated
using (
  public.is_verified_campus_user()
  and (
    public.is_campus_staff()
    or claimant_id = (select auth.uid())
    or exists (
      select 1 from public.campus_items i
      where i.id = item_id and i.owner_id = (select auth.uid())
    )
  )
);

create or replace function public.start_campus_handover(p_claim_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item_id uuid;
  v_claimant_id uuid;
  v_owner_id uuid;
  v_custody_id uuid;
begin
  if not public.is_campus_staff() or not public.is_verified_campus_user() then
    raise exception 'Only verified campus staff can start a handover.';
  end if;
  select c.item_id, c.claimant_id, i.owner_id
    into v_item_id, v_claimant_id, v_owner_id
  from public.campus_claims c
  join public.campus_items i on i.id = c.item_id
  where c.id = p_claim_id and c.status = 'approved'
    and i.status = 'found' and not i.resolved
    and not exists (
      select 1 from public.campus_claims other
      where other.item_id = i.id and other.id <> c.id
        and other.status in ('handover_pending','recovered')
    )
  for update of c, i;
  if v_item_id is null then
    raise exception 'The claim must be approved for an open found report.';
  end if;
  insert into public.campus_custody(item_id, claim_id, staff_id, claimant_id)
  values (v_item_id, p_claim_id, (select auth.uid()), v_claimant_id)
  returning id into v_custody_id;
  update public.campus_claims set status = 'handover_pending' where id = p_claim_id;
  return v_custody_id;
end;
$$;
revoke all on function public.start_campus_handover(uuid) from public, anon;
grant execute on function public.start_campus_handover(uuid) to authenticated;

create or replace function public.complete_campus_handover(p_custody_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_custody public.campus_custody%rowtype;
begin
  if not public.is_campus_staff() or not public.is_verified_campus_user() then
    raise exception 'Only verified campus staff can complete a handover.';
  end if;
  select * into v_custody
  from public.campus_custody
  where id = p_custody_id and staff_id = (select auth.uid())
  for update;
  if not found or v_custody.status <> 'in_custody' then
    raise exception 'This handover is no longer active.';
  end if;
  if not (v_custody.identity_checked and v_custody.item_checked and v_custody.recipient_acknowledged) then
    raise exception 'Complete all three handover checks first.';
  end if;
  update public.campus_custody set status = 'released', handover_at = now() where id = p_custody_id;
  update public.campus_claims set status = 'recovered' where id = v_custody.claim_id;
  update public.campus_items set resolved = true where id = v_custody.item_id;
  return true;
end;
$$;
revoke all on function public.complete_campus_handover(uuid) from public, anon;
grant execute on function public.complete_campus_handover(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
