-- ============================================================================
-- A USD source now says HOW the dollars reach the platform (Payoneer, PayPal,
-- Wise, Rizon, Binance) — follow-up to 20260723000041_platform_usd_stock_ledger.
--
-- Nullable on purpose: a source that already exists (created before this
-- column) has no method until someone sets it, and inventing one would be
-- wrong. New sources must choose one — that is enforced where the list lives,
-- in src/schemas/platform-finance.ts (USD_PAYMENT_METHODS), not here.
--
-- Deliberately NO check constraint. The list is expected to change (the client
-- payment-method list was extended twice in a day) and a CHECK would turn every
-- addition into a migration; payments.payment_method is handled the same way.
-- The single shared list is read by both the dialog and the server-side enum,
-- so the two cannot disagree.
--
-- Distinct from usd_purchases.method, which is free text about how a
-- particular purchase was paid for. This is a property of the source itself:
-- the USD channel it delivers through.
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   alter table public.usd_sources drop column payment_method;
-- ============================================================================

alter table public.usd_sources add column payment_method text;
comment on column public.usd_sources.payment_method is
  'USD channel this source delivers through (Payoneer, PayPal, Wise, Rizon, Binance). '
  'NULL for sources created before the column existed. Validated in app code, not by a CHECK.';
