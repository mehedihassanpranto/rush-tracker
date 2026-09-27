-- ============================================================================
-- "Today" alongside the all-time totals in agency_limit_approvals_summary —
-- follow-up to 20260723000043.
--
-- Adds today_usd_approved / today_approval_count: approved limit requests on
-- PLATFORM-OWNED accounts whose approval falls on today's business day. The day
-- is Asia/Dhaka, the same business day the agency dashboard's "today" figures
-- use (admin_today_totals, migration 000006) — NOT the database's UTC day, which
-- would roll over at 6am in Dhaka and split one working day across two "todays".
--
-- Both columns are appended at the END, the only change CREATE OR REPLACE VIEW
-- permits on an existing view; the first four columns are byte-identical. The
-- sum is coalesced so a quiet day reads 0, not NULL (the all-time columns
-- cannot be NULL — a group only exists if it has a row).
--
-- Same access rules as before: security_invoker AND revoked from anon and
-- authenticated. The revoke is repeated here on purpose — it costs nothing and
-- means this migration never depends on how CREATE OR REPLACE treats grants.
--
-- MANUAL ROLLBACK (no down-migrations in this project): re-run the view from
-- 20260723000043 without the two new columns after
--   drop view public.agency_limit_approvals_summary;
-- ============================================================================

create or replace view public.agency_limit_approvals_summary
  with (security_invoker = true) as
select
  lr.organization_id,
  sum(lr.approved_amount_usd) as total_usd_approved,
  count(*)                    as approval_count,
  max(lr.approved_at)         as last_approved_at,
  coalesce(
    sum(lr.approved_amount_usd) filter (
      where (lr.approved_at at time zone 'Asia/Dhaka')::date
          = (now() at time zone 'Asia/Dhaka')::date
    ),
    0
  )                           as today_usd_approved,
  count(*) filter (
    where (lr.approved_at at time zone 'Asia/Dhaka')::date
        = (now() at time zone 'Asia/Dhaka')::date
  )                           as today_approval_count
from public.limit_requests lr
join public.ad_accounts a on a.id = lr.ad_account_id
where lr.status = 'APPROVED'
  and a.is_platform
group by lr.organization_id;
revoke all on public.agency_limit_approvals_summary from anon, authenticated;
