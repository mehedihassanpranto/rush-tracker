-- ============================================================================
-- Finance v2 — purchases, USD payouts and agency sales can't be deleted
-- (follow-up to 000061).
--
-- The journal is insert-only, so deleting a source row left its entry behind:
-- a deleted purchase vanished from the FIFO stock but stayed in the USD
-- inventory account, and the books no longer tied out. Found on staging,
-- where a test cleaned up by deleting purchases and sales. The app never
-- deletes these rows; now the database refuses to as well.
--
-- Corrections are reversals: reverse_usd_purchase(), reverse_usd_outflow().
-- (A sale has no reversal path yet — receivables are Milestone 4.)
--
-- Only DELETE is blocked. An agency's deletion still sets usd_sales.
-- organization_id / ad_account_id to NULL (an UPDATE, ON DELETE SET NULL,
-- 000041), and reversals still update status.
--
-- MANUAL ROLLBACK:
--   drop trigger trg_usd_purchases_no_delete on public.usd_purchases;
--   drop trigger trg_usd_outflows_no_delete on public.usd_outflows;
--   drop trigger trg_usd_sales_no_delete on public.usd_sales;
-- ============================================================================

create trigger trg_usd_purchases_no_delete
  before delete on public.usd_purchases
  for each row execute function public.finance_block_mutation();
create trigger trg_usd_outflows_no_delete
  before delete on public.usd_outflows
  for each row execute function public.finance_block_mutation();
create trigger trg_usd_sales_no_delete
  before delete on public.usd_sales
  for each row execute function public.finance_block_mutation();
