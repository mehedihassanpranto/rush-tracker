-- ============================================================================
-- Rush Tracker — scope notifications to the client they're about, so a
-- login belonging to multiple clients (migration 20260723000022 + the
-- client-switcher fix next to it in CHANGELOG.md/CLAUDE.md) can have its
-- notification LIST follow the "active client" cookie the same way every
-- other portal page now does, without the unread COUNT badge silently
-- hiding something that happened on a client the user isn't currently
-- viewing.
--
-- Nullable, on purpose: only notifyClientMembers() (client-facing events —
-- limit request approved, payment approved, adjustment, etc.) ever knows a
-- client_id at the point a notification is created. notifyAdmins() and any
-- other admin-facing call never reaches a CLIENT-role user at all, so
-- those rows simply stay client_id = null and are never filtered — an
-- admin's own notifications list never applies the client filter.
-- ============================================================================

alter table public.notifications
  add column client_id uuid references public.clients (id) on delete cascade;

create index idx_notifications_user_client
  on public.notifications (user_id, client_id, created_at desc);
