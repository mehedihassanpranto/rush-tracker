import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import {
  CLIENT_PERMISSION_KEYS,
  CLIENT_PERMISSION_LABELS,
  normalizeClientPermissions,
} from '@/lib/permissions/client-permissions'
import type { ClientPermission } from '@/lib/permissions/client-permissions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'

/** A client portal login's access (000069). */
export interface PortalAccess {
  is_owner: boolean
  permissions: Array<string>
}

/** What a new Member starts with. */
export const NEW_MEMBER_ACCESS: PortalAccess = { is_owner: false, permissions: ['requests.create'] }

/**
 * Owner switch + a Member's permissions. Ticking "Make payments" ticks "See
 * billing" (paying means seeing what's owed); unticking "See billing" drops
 * "Make payments". `canMakeOwner` / `grantable` mirror the server's rules for
 * whoever is editing (the server checks them too).
 */
export function PortalAccessFields({
  value,
  onChange,
  canMakeOwner = true,
  grantable,
  idPrefix = 'access',
}: {
  value: PortalAccess
  onChange: (next: PortalAccess) => void
  canMakeOwner?: boolean
  /** Permissions the editor may hand out; omitted → all. */
  grantable?: ReadonlyArray<string>
  idPrefix?: string
}) {
  function toggle(key: ClientPermission, on: boolean) {
    const set = new Set(value.permissions)
    if (on) set.add(key)
    else {
      set.delete(key)
      if (key === 'billing.view') set.delete('payments.create')
    }
    onChange({ ...value, permissions: normalizeClientPermissions(set) })
  }

  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Portal access</legend>
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={`${idPrefix}-owner`}
          checked={value.is_owner}
          disabled={!canMakeOwner}
          onCheckedChange={(v) => onChange({ ...value, is_owner: v === true })}
          className="mt-0.5"
        />
        <div>
          <Label htmlFor={`${idPrefix}-owner`} className="text-sm">
            Owner
          </Label>
          <p className="text-xs text-muted-foreground">
            Can do everything, including managing owners.
          </p>
        </div>
      </div>
      <ul className="space-y-2 border-t pt-3">
        {CLIENT_PERMISSION_KEYS.map((key) => {
          const allowed = !grantable || grantable.includes(key)
          return (
            <li key={key} className="flex items-start gap-2.5">
              <Checkbox
                id={`${idPrefix}-${key}`}
                checked={value.is_owner || value.permissions.includes(key)}
                disabled={value.is_owner || !allowed}
                onCheckedChange={(v) => toggle(key, v === true)}
                className="mt-0.5"
              />
              <div>
                <Label htmlFor={`${idPrefix}-${key}`} className="text-sm font-normal">
                  {CLIENT_PERMISSION_LABELS[key].label}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {CLIENT_PERMISSION_LABELS[key].hint}
                  {!allowed && !value.is_owner && ' · you don’t have this yourself'}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        Everyone can see the ad accounts, limit requests and team.
      </p>
    </fieldset>
  )
}

/** "Owner", or a Member's permissions in a few words. */
export function AccessSummary({ access }: { access: PortalAccess }) {
  if (access.is_owner) {
    return (
      <Badge
        variant="outline"
        className="border-transparent bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300"
      >
        Owner
      </Badge>
    )
  }
  const labels = CLIENT_PERMISSION_KEYS.filter((k) => access.permissions.includes(k)).map(
    (k) => CLIENT_PERMISSION_LABELS[k].label,
  )
  return (
    <span className="text-sm text-muted-foreground">
      {labels.length > 0 ? labels.join(' · ') : 'View only'}
    </span>
  )
}

/** Change one login's access. `onSave` is the caller's server fn. */
export function EditAccessDialog({
  target,
  onOpenChange,
  onSave,
  saving,
  canMakeOwner,
  grantable,
}: {
  target: { id: string; name: string; access: PortalAccess } | null
  onOpenChange: (open: boolean) => void
  onSave: (access: PortalAccess) => void
  saving: boolean
  canMakeOwner?: boolean
  grantable?: ReadonlyArray<string>
}) {
  const [access, setAccess] = useState<PortalAccess>(NEW_MEMBER_ACCESS)
  // Reset only when a different login opens — the parent may rebuild
  // `target` on any render.
  const targetId = target?.id ?? null
  useEffect(() => {
    if (target) setAccess({ is_owner: target.access.is_owner, permissions: target.access.permissions })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId])

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Portal access — {target?.name}</DialogTitle>
          <DialogDescription>Takes effect the next time they load a page.</DialogDescription>
        </DialogHeader>
        <PortalAccessFields
          value={access}
          onChange={setAccess}
          canMakeOwner={canMakeOwner}
          grantable={grantable}
          idPrefix="edit-access"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSave(access)} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
