-- ============================================================================
-- Approved limit requests, totalled per agency — for the platform's Agency
-- Summary (Finance & Accounts). Follow-up to 20260723000041.
--
-- The owner's rule: the USD amount of every APPROVED limit request counts
-- toward what the platform has allocated to that agency, alongside the sales
-- recorded by hand in usd_sales.
--
-- WHICH REQUESTS COUNT: approved requests on PLATFORM-OWNED accounts
-- (ad_accounts.is_platform), all time. Those are the dollars the platform
-- actually raised a spend cap for. An approved request on an account an agency
-- owns outright (its own Meta portfolio) is not a platform allocation — the
-- platform sold nothing — so it is excluded. Today every account is
-- platform-owned, so this changes no number yet; it matters the day an agency
-- imports its own.
--
-- THIS DOES NOT TOUCH THE STOCK POSITION. usd_stock_summary (total USD sold,
-- remaining stock, gross BDT difference) still reads usd_sales only. A limit
-- approval has no BDT received attached to it, so folding its USD into "sold"
-- would drive the gross difference negative by inventing dollars leaving stock
-- for nothing. Whether approvals should draw stock down, and at what BDT, is a
-- separate decision.
--
-- Same access rules as the other ledger views (migration 000041): the amounts
-- are one agency's totals as the platform sees them, so the view is
-- security_invoker AND revoked from anon/authenticated — service role only.
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   drop view public.agency_limit_approvals_summary;
-- ============================================================================

create view public.agency_limit_approvals_summary
  with (security_invoker = true) as
select
  lr.organization_id,
  sum(lr.approved_amount_usd) as total_usd_approved,
  count(*)                    as approval_count,
  max(lr.approved_at)         as last_approved_at
from public.limit_requests lr
join public.ad_accounts a on a.id = lr.ad_account_id
where lr.status = 'APPROVED'
  and a.is_platform
group by lr.organization_id;
revoke all on public.agency_limit_approvals_summary from anon, authenticated;
comment on view public.agency_limit_approvals_summary is
  'Per agency: total USD of APPROVED limit requests on platform-owned accounts. '
  'Counts toward the Agency Summary''s USD allocated; does NOT feed usd_stock_summary.';
