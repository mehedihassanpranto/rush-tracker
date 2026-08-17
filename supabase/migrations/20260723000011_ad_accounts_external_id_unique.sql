-- ----------------------------------------------------------------------------
-- Prevent two ad_accounts rows from ever linking to the same Meta ad
-- account. external_account_id was previously indexed but not unique —
-- concurrent "Import from Meta" submissions (two admin sessions, or a
-- double-submit) could create duplicate rows for one external account,
-- silently confusing every lookup keyed by external_account_id
-- (currentClientMap, listMetaBusinessAdAccountsFn, the sync cron).
--
-- Partial (where not null) since external_account_id is optional —
-- manually-created accounts with no Meta link must still be allowed to
-- coexist with null.
-- ----------------------------------------------------------------------------
drop index if exists public.idx_ad_accounts_external;

create unique index idx_ad_accounts_external_unique
  on public.ad_accounts (external_account_id)
  where external_account_id is not null;
