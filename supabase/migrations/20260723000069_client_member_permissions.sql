-- ============================================================================
-- Client team permissions (owner request, 2026-11-28): a client's portal
-- logins are Owners or Members.
--
--   is_owner     an Owner can do everything in the portal, and only an Owner
--                makes or removes Owners (or changes an Owner's access).
--   permissions  what a Member may do beyond viewing the client's ad accounts
--                and limit requests:
--                  requests.create   raise and cancel limit requests
--                  payments.create   submit and cancel payments
--                  billing.view      due, payments, payment requests,
--                                    statement and the money on the dashboard
--                  team.manage       add Members, set their access, turn
--                                    their logins on and off
--                Ignored for an Owner.
--
-- Every existing membership becomes an Owner, so nobody loses access. The
-- column DEFAULTS to Owner too, so code that predates this (it never sets
-- the column) keeps creating logins with today's full access; the new code
-- always sets both columns.
--
-- MANUAL ROLLBACK:
--   alter table public.client_memberships
--     drop constraint client_memberships_permissions_check,
--     drop column permissions, drop column is_owner;
-- ============================================================================

alter table public.client_memberships
  add column is_owner boolean not null default true,
  add column permissions text[] not null default '{}';

alter table public.client_memberships
  add constraint client_memberships_permissions_check
  check (permissions <@ array['requests.create', 'payments.create', 'billing.view', 'team.manage']::text[]);

comment on column public.client_memberships.is_owner is
  'Owner of this client''s portal: full access, and the only one who manages Owners.';
comment on column public.client_memberships.permissions is
  'A Member''s portal permissions (requests.create, payments.create, billing.view, team.manage). Ignored for an Owner.';
