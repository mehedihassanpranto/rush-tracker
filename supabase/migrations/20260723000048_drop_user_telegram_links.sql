-- Drop the superseded per-user Telegram tables from migration 000045.
--
-- 000045 linked one Telegram chat per LOGIN (user_telegram_links +
-- telegram_link_tokens). It was replaced by 000047's multi-role design
-- (telegram_subscriptions / telegram_link_requests / notification_events),
-- which links chats per platform admin, agency and client instead. The app
-- code for the per-user design was removed when the Finance feature was
-- reintegrated (commit 02f66e9); nothing reads or writes these tables.
--
-- Both were confirmed EMPTY on the live project immediately before writing
-- this (0 rows each), so nothing is lost.
--
-- Plain DROP, deliberately no CASCADE: if some view or function had come to
-- depend on either table, this should fail loudly rather than silently take
-- that dependent object with it.
--
-- MANUAL ROLLBACK (no down-migrations in this project): re-run
-- 20260723000045_user_telegram_links.sql.

drop table public.telegram_link_tokens;
drop table public.user_telegram_links;
