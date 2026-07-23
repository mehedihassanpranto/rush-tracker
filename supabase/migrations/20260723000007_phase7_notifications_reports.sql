-- ============================================================================
-- Rush Tracker — Phase 7: Notifications, Reports and Audit
--
--   * notifications table (spec §54) — in-app only, no external providers.
--     Rows are written server-side (service role) after a successful
--     transaction; the browser gets READ-ONLY access to its OWN rows.
--   * all_client_dues() — every client's billed / paid / current due, derived
--     from the authoritative ledger (spec §71 "Client Due Report").
--
-- Security model unchanged (spec §5, §59, §60): no write policies for
-- `authenticated`; all writes go through the server layer.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- In-app notifications (spec §54)
-- ----------------------------------------------------------------------------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  type        text not null,
  title       text not null,
  message     text,
  entity_type text,
  entity_id   text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index idx_notifications_user
  on public.notifications (user_id, created_at desc);
create index idx_notifications_unread
  on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

-- A user may read only their own notifications. Marking-as-read is a write and
-- therefore goes through the server layer with the service-role key.
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- Client Due Report source (spec §71). Every client with billed / paid / due,
-- all derived from the ledger — never a stored balance (spec §35).
-- ----------------------------------------------------------------------------
create or replace function public.all_client_dues()
returns table (
  client_id    uuid,
  client_code  text,
  name         text,
  status       public.client_status,
  total_billed numeric,
  total_paid   numeric,
  current_due  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.client_code,
    c.name,
    c.status,
    coalesce(sum(l.debit_bdt), 0) as total_billed,
    coalesce(sum(l.credit_bdt), 0) as total_paid,
    coalesce(sum(l.debit_bdt), 0) - coalesce(sum(l.credit_bdt), 0) as current_due
  from public.clients c
  left join public.ledger_entries l on l.client_id = c.id
  group by c.id, c.client_code, c.name, c.status
  order by current_due desc, c.name;
$$;

revoke all on function public.all_client_dues() from public;
grant execute on function public.all_client_dues() to service_role;
