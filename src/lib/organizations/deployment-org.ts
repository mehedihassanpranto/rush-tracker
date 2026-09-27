/**
 * "Org zero" — the organization belonging to whoever runs this deployment
 * (xRush Agency), seeded with this hand-picked sentinel id by the Phase 1
 * multi-tenant migration.
 *
 * **It is no longer where the Meta credentials live.** Until migration 000037
 * the `META_*` env vars were treated as this organization's own, which made
 * xRush Agency and the Rush Tracker platform the same entity for credential
 * purposes — see `MetaCredentialScope` in src/lib/meta/credential-scope.ts and
 * `platform_settings`. The platform's portfolio is now its own scope, editable
 * only from the platform panel. Do not reintroduce an org-zero fallback here:
 * an agency with no credentials of its own must have no Meta integration,
 * rather than quietly seeing someone else's ad accounts.
 *
 * What it is still used for:
 *   - The legacy `TELEGRAM_CHAT_ID` is imported as THIS organization's agency
 *     chat (importLegacyTelegramChatFn). Telegram is otherwise per-recipient
 *     since migration 000047 — no alert is gated on org zero any more.
 *   - `audit_logs.organization_id` is NOT NULL, but a pool account that is
 *     currently ungranted belongs to no agency — org zero is the fallback
 *     owner of those rows.
 *   - Offboarding refuses to delete it: it owns every platform login.
 *
 * Note this is NOT a real RFC 4122 UUID (its version nibble is 0) — see
 * `src/schemas/organization.ts` for why `z.uuid()` rejects it.
 */
export const DEPLOYMENT_ORGANIZATION_ID =
  '00000000-0000-0000-0000-000000000001'
