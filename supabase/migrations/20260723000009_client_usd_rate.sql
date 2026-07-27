-- ============================================================================
-- Per-client USD rate
--
-- Moves the USD→BDT billing rate from a single global setting to a per-client
-- value: "the rate charged per US dollar for this client". Set at client
-- creation, editable on the client, and used as the default rate when
-- approving that client's limit requests and for all USD due conversions.
--
-- Existing global exchange_rates history is preserved (approvals keep their
-- immutable snapshot); existing clients are backfilled from the latest
-- configured global rate so their USD figures keep working.
-- ============================================================================

alter table public.clients
  add column if not exists usd_rate numeric(10, 4) not null default 0;

-- Backfill existing clients from the latest configured global rate.
update public.clients
set usd_rate = coalesce(
  (select rate from public.exchange_rates order by effective_from desc limit 1),
  0
)
where usd_rate = 0;

comment on column public.clients.usd_rate is
  'USD→BDT rate charged per dollar for this client (billing + display).';
