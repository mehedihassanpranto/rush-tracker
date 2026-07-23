-- ============================================================================
-- Rush Tracker — Phase 6: Dashboard aggregate functions (read-only).
--
-- These compute figures the supabase-js client can't (SUM / GROUP BY) directly.
-- All values derive from the authoritative ledger (spec §65). "Today" uses the
-- Asia/Dhaka business day.
-- ============================================================================

-- Today's approved limit USD, approved billing BDT, and collected BDT.
create or replace function public.admin_today_totals()
returns table (
  approved_limit_usd   numeric,
  approved_billing_bdt numeric,
  collection_bdt       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(usd_amount) filter (where type = 'LIMIT_APPROVAL'), 0),
    coalesce(sum(debit_bdt) filter (where type = 'LIMIT_APPROVAL'), 0),
    coalesce(sum(credit_bdt) filter (where type = 'PAYMENT'), 0)
  from public.ledger_entries
  where (created_at at time zone 'Asia/Dhaka')::date
      = (now() at time zone 'Asia/Dhaka')::date;
$$;

-- Clients ranked by outstanding due (spec §65 "Clients With Highest Due").
create or replace function public.top_due_clients(p_limit int default 5)
returns table (
  client_id   uuid,
  client_code text,
  name        text,
  current_due numeric
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
    coalesce(sum(l.debit_bdt), 0) - coalesce(sum(l.credit_bdt), 0) as current_due
  from public.clients c
  join public.ledger_entries l on l.client_id = c.id
  group by c.id, c.client_code, c.name
  having coalesce(sum(l.debit_bdt), 0) - coalesce(sum(l.credit_bdt), 0) > 0
  order by current_due desc
  limit p_limit;
$$;

revoke all on function public.admin_today_totals() from public;
revoke all on function public.top_due_clients(int) from public;
grant execute on function public.admin_today_totals() to service_role;
grant execute on function public.top_due_clients(int) to service_role;
