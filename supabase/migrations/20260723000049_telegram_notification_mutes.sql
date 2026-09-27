-- Per-connected-chat mute list for individual Telegram event types.
--
-- notifyTelegram() already addresses each event to exactly the one tenant it
-- belongs to (migration 000047's isolation rule) -- this is a second, narrower
-- axis on top of that: once a chat is eligible to receive an event at all,
-- whoever can see that chat in Settings can additionally turn specific event
-- types off for it, the same way they can already disconnect it outright.
--
-- Absence of a row means "enabled" -- the unchanged default for every
-- existing connection -- and a row here means "muted". This avoids needing to
-- pre-populate one row per (subscription, event type) and avoids needing a
-- database catalog of event types at all: that catalog lives in code
-- (src/lib/telegram/event-types.ts), a fixed list tied to the
-- notifyTelegram() call sites that raise these events, not agency-editable
-- data, so a code list next to those call sites can't drift the way a
-- separate DB table could.
create table public.telegram_notification_mutes (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.telegram_subscriptions (id) on delete cascade,
  event_type text not null,
  created_at timestamptz not null default now(),
  unique (subscription_id, event_type)
);

-- Same treatment as telegram_subscriptions itself: reachable only through the
-- service-role server layer, after authorization -- never queried directly
-- from a browser session.
alter table public.telegram_notification_mutes enable row level security;

-- One more possible outcome for notifyTelegram()'s delivery log, alongside
-- the three that already exist (pending is the row default, never actually
-- persisted by notifyTelegram() itself, which only ever inserts a final
-- status in one write).
alter table public.notification_events drop constraint notification_events_status_check;
alter table public.notification_events add constraint notification_events_status_check
  check (status in ('pending', 'sent', 'failed', 'skipped_no_subscription', 'skipped_preference_off'));
