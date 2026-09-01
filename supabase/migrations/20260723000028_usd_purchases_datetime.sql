-- ============================================================================
-- Rush Tracker — usd_purchases.purchase_date: date -> timestamptz.
--
-- Follow-up to 20260723000027_finance_usd_purchases.sql (already applied
-- live, table confirmed empty). Owner asked to capture time-of-day on a
-- purchase, not just the date — scoped to this one column, per the request.
-- Postgres rebuilds the column's index automatically on a TYPE change.
-- ============================================================================

alter table public.usd_purchases
  alter column purchase_date type timestamptz
  using purchase_date::timestamptz;
