-- ============================================================================
-- Per-user Telegram delivery.
--
-- TELEGRAM_CHAT_ID is one chat for the whole deployment. This lets each person
-- connect THEIR OWN Telegram, and receive their own notifications there.
--
--   user_telegram_links    the connection: which Telegram chat belongs to which
--                          login. One per user (the primary key).
--   telegram_link_tokens   the short-lived, single-use secret that proves the
--                          person pressing Start in Telegram is the person signed
--                          in to the app. Only a SHA-256 of the token is stored,
--                          so reading this table never yields a usable link.
--
-- Both tables reference auth.users ON DELETE CASCADE and carry no
-- organization_id: they belong to a login, and a login's organization is on
-- user_profiles. So they need no place in OFFBOARD_ORDER / WIPE_ORDER — deleting
-- the user (which offboarding and "clear all data" both do) removes them.
--
-- ACCESS: chat ids identify a person's Telegram account, and a live token would
-- let anyone who read it attach their Telegram to someone else's login. So, as
-- with app_settings and the platform ledger: RLS enabled with ZERO policies AND
-- every anon/authenticated grant revoked. Reachable only through the service-role
-- server layer, which returns a person nothing but their own linked/not-linked
-- status.
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   drop table public.telegram_link_tokens;
--   drop table public.user_telegram_links;
-- ============================================================================

create table public.user_telegram_links (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  chat_id           bigint not null,
  telegram_username text,
  linked_at         timestamptz not null default now()
);
comment on table public.user_telegram_links is
  'A login''s own Telegram chat. Every in-app notification the user receives is also sent here. Unlinked by the user, by /stop in the chat, or automatically when Telegram reports the bot was blocked.';
create table public.telegram_link_tokens (
  token_hash text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index telegram_link_tokens_user_idx on public.telegram_link_tokens (user_id);
comment on table public.telegram_link_tokens is
  'Single-use proof that a Telegram /start came from the signed-in user. SHA-256 of the token only; consumed by a DELETE ... RETURNING so two racing /start calls cannot both win.';
alter table public.user_telegram_links enable row level security;
alter table public.telegram_link_tokens enable row level security;
revoke all on public.user_telegram_links from anon, authenticated;
revoke all on public.telegram_link_tokens from anon, authenticated;
