import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'

const PROOFS_BUCKET = 'proofs'
const SIGNED_URL_TTL_SECONDS = 60 // short-lived (spec §52)

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

export interface StoredProof {
  storage_path: string
  file_size: number
}

/**
 * Upload a proof file to the private `proofs` bucket under a randomized path
 * (spec §50 — never trust original filenames as keys). Server-only.
 */
export async function uploadProof(params: {
  folder: string // e.g. "limit-requests/{requestId}"
  mimeType: string
  dataBase64: string
}): Promise<StoredProof> {
  const admin = getSupabaseAdminClient()
  const buffer = Buffer.from(params.dataBase64, 'base64')
  const ext = EXT_BY_MIME[params.mimeType] ?? 'bin'
  const path = `${params.folder}/${crypto.randomUUID()}.${ext}`

  const { error } = await admin.storage
    .from(PROOFS_BUCKET)
    .upload(path, buffer, { contentType: params.mimeType, upsert: false })
  if (error) throw new Error(error.message)

  return { storage_path: path, file_size: buffer.byteLength }
}

/** Mint a short-lived signed URL for a stored proof (spec §52). */
export async function signProofUrl(storagePath: string): Promise<string> {
  const admin = getSupabaseAdminClient()
  const { data, error } = await admin.storage
    .from(PROOFS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
  if (error || !data) throw new Error(error?.message ?? 'Could not sign URL')
  return data.signedUrl
}

export { PROOFS_BUCKET }
