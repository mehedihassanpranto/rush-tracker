-- Fix: client_financials().total_approved_usd never netted reversals.
--
-- Found live: a client (Gopal, CL-0086, Arrow Solutions) had a duplicate
-- limit-request approval accidentally posted twice ($280 approved twice on
-- the same account increase). The duplicate's ledger debit was correctly
-- reversed via reverse_financial_transaction() -- current_due already nets
-- out to the right figure ($0, matching the real state) because it's a
-- plain sum(debit_bdt) - sum(credit_bdt) over ALL entry types.
--
-- total_approved_usd did NOT get the same treatment: it was
-- `sum(usd_amount) filter (where type = 'LIMIT_APPROVAL')`, which counts
-- every LIMIT_APPROVAL debit regardless of whether it was later reversed --
-- so it kept showing $560 (280+280) instead of $280, on both the agency
-- client-detail page's Financial Summary card and the client portal
-- dashboard (both read client_financials() directly, src/server/dashboard/
-- dashboard.fns.ts and src/components/shared/financial-summary.tsx).
--
-- Fix: subtract the usd_amount of any REVERSAL entry whose reference_id
-- (ledger_entries.id, stored as text -- see reverse_financial_transaction)
-- points at a LIMIT_APPROVAL entry for the same client. Scoped narrowly to
-- LIMIT_APPROVAL reversals specifically, so a reversed PAYMENT or
-- ADJUSTMENT_DEBIT (which reverse_financial_transaction also supports)
-- never affects this figure -- it was never counted in total_approved_usd
-- to begin with.
--
-- total_debit / total_credit / current_due are untouched -- they were
-- already correct.

create or replace function public.client_financials(p_client_id uuid)
returns table (
  total_debit        numeric,
  total_credit        numeric,
  current_due         numeric,
  total_approved_usd  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with le as (
    select * from public.ledger_entries where client_id = p_client_id
  ),
  reversed_approvals as (
    select rev.usd_amount
    from le rev
    join le orig on orig.id::text = rev.reference_id
    where rev.type = 'REVERSAL' and orig.type = 'LIMIT_APPROVAL'
  )
  select
    coalesce((select sum(debit_bdt) from le), 0),
    coalesce((select sum(credit_bdt) from le), 0),
    coalesce((select sum(debit_bdt) from le), 0) - coalesce((select sum(credit_bdt) from le), 0),
    coalesce((select sum(usd_amount) from le where type = 'LIMIT_APPROVAL'), 0)
      - coalesce((select sum(usd_amount) from reversed_approvals), 0);
$$;
