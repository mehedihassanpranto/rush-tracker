import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { notifyClientMembers } from '@/server/notifications/notification.service'
import { notifyTelegram } from '@/server/telegram/telegram.service'
import { syncAndPersistAdAccountSpendCap } from '@/server/meta/spend-cap-sync.server'
import { formatUsd } from '@/lib/money/money'

/**
 * Shared logic between an agency's own approval (approveLimitRequestFn,
 * limit-request.fns.ts) and a platform admin's approval of an escalated
 * request (approvePlatformLimitRequestFn, server/platform/limit-requests.fns.ts).
 *
 * This lives in its own plain service module — not exported from either
 * .fns.ts file — on purpose: a plain function that touches a .server.ts
 * import is only safe to export from a .fns.ts file if every call site is
 * confined to that SAME file's createServerFn().handler() bodies, which get
 * specially stripped from the client bundle. Once a second .fns.ts file
 * imports it by name (as both approve fns need to), the bundler can no
 * longer prove the binding is unused in the client build, so its body (and
 * the getSupabaseAdminClient() call inside it) survives into the client
 * bundle and the import-protection plugin correctly refuses the build. This
 * bit a real build here (see CHANGELOG) — matches the file's own
 * documented "ReturnType<typeof getSupabaseAdminClient>" gotcha, just
 * triggered by a plain function instead of a type alias. audit.service.ts /
 * notification.service.ts already follow this same shape for the same
 * reason: shared server-only helpers live in a plain service module used
 * only from within handler bodies, never re-exported from another .fns.ts.
 */

export const PROOF_ENTITY = 'LIMIT_APPROVAL_PROOF'

export async function proofPathForRequest(requestId: string): Promise<string | null> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('attachments')
    .select('storage_path')
    .eq('entity_type', PROOF_ENTITY)
    .eq('entity_id', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { storage_path: string } | null)?.storage_path ?? null
}

/**
 * Everything that happens after approve_limit_request commits, regardless of
 * who approved it (an agency admin directly, or a platform admin reviewing an
 * escalated request) — proof-linking, notifying the client, and the
 * best-effort Meta spend-cap push.
 */
export async function finishLimitRequestApproval(
  actorId: string,
  requestId: string,
  approvedAmountUsd: number,
  paymentId: string | null,
  // The CLIENT's own agency — never the actor's own organization, since the
  // actor may be a platform admin with no agency of their own. Both call
  // sites resolve this from the request row (or already have it as their own
  // org, for the agency's own approve path) before calling here.
  organizationId: string,
): Promise<void> {
  const admin = getSupabaseAdminClient()

  // Prepaid/partial only (paymentId is null for postpaid — nothing to link).
  // Link the client's already-uploaded request proof to the auto-created
  // payment too, so it shows in Payment History with proof like any other
  // payment — best-effort, never blocks the (already-committed) approval.
  try {
    const path = paymentId ? await proofPathForRequest(requestId) : null
    if (paymentId && path) {
      const { data: att } = await admin
        .from('attachments')
        .select('original_file_name, mime_type, file_size')
        .eq('entity_type', PROOF_ENTITY)
        .eq('entity_id', requestId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      await admin.from('attachments').insert({
        entity_type: 'PAYMENT_PROOF',
        entity_id: paymentId,
        storage_bucket: 'proofs',
        storage_path: path,
        original_file_name: (att as { original_file_name: string | null } | null)
          ?.original_file_name,
        mime_type: (att as { mime_type: string | null } | null)?.mime_type,
        file_size: (att as { file_size: number | null } | null)?.file_size,
        uploaded_by: actorId,
        organization_id: organizationId,
      })
    }
  } catch (err) {
    console.error('[limit-request] failed to link proof to auto-payment', requestId, err)
  }

  const { data: req } = await admin
    .from('limit_requests')
    .select('client_id, request_number, ad_account_id')
    .eq('id', requestId)
    .maybeSingle()
  if (!req) return
  const r = req as { client_id: string; request_number: string; ad_account_id: string }

  await notifyClientMembers(r.client_id, {
    type: 'LIMIT_REQUEST_APPROVED',
    title: 'Limit request approved',
    message: `${r.request_number}: approved for ${formatUsd(approvedAmountUsd)}`,
    entityType: 'LIMIT_REQUEST',
    entityId: requestId,
  })
  await notifyTelegram({
    eventType: 'limit_request.approved',
    recipient: { type: 'client', clientId: r.client_id },
    text: `✅ Your limit request ${r.request_number} was approved for ${formatUsd(approvedAmountUsd)}.`,
    payload: { limit_request_id: requestId, request_number: r.request_number },
  })

  // Best-effort: push the new limit to the linked Meta ad account's
  // spend_cap. Never throws — a Meta-side failure must not roll back this
  // approval (already committed atomically above); it's flagged via
  // meta_sync_pending + a notification + retry instead. Resolves the right
  // Meta credentials from the account's OWN ownership (metaCredentialScopeFor
  // inside syncAndPersistAdAccountSpendCap), so this is correct whether the
  // approver was the agency or the platform.
  await syncAndPersistAdAccountSpendCap(r.ad_account_id, {
    actorUserId: actorId,
    source: 'META_SPEND_CAP_AUTO_SYNC',
  })
}
