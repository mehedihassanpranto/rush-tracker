import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Download, Megaphone, MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'

import {
  grantPoolAccountFn,
  listPoolAccountsFn,
} from '@/server/platform/pool.fns'
import { listOrganizationsFn } from '@/server/organizations/organization.fns'
import { RevokeGrantDialog } from '@/components/platform/organizations/revoke-grant-dialog'
import { PoolImportDialog } from '@/components/platform/ad-accounts/pool-import-dialog'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { StatusBadge } from '@/components/shared/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatUsd } from '@/lib/money/money'

/**
 * The platform's central ad account pool. Access is enforced by the /platform
 * layout guard; the real boundary is requirePlatformAdmin() on every server fn
 * called here.
 *
 * Granting is push-only — an agency has no screen to browse or request pool
 * accounts, by design.
 */
export const Route = createFileRoute('/platform/ad-accounts/')({
  component: PoolPage,
})

function PoolPage() {
  const queryClient = useQueryClient()
  const listPool = useServerFn(listPoolAccountsFn)
  const listOrganizations = useServerFn(listOrganizationsFn)
  const grant = useServerFn(grantPoolAccountFn)
  const [search, setSearch] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  // Revoking is confirmed, not a bare dropdown click — see RevokeGrantDialog.
  const [toRevoke, setToRevoke] = useState<{
    adAccountId: string
    accountLabel: string
    agencyName: string
  } | null>(null)

  const { data: rows, isLoading } = useQuery({
    queryKey: ['platform-pool-accounts'],
    queryFn: () => listPool(),
  })
  const { data: organizations } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => listOrganizations(),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
  }

  const grantMutation = useMutation({
    mutationFn: (vars: { ad_account_id: string; organization_id: string }) =>
      grant({ data: vars }),
    onSuccess: () => {
      toast.success('Account granted')
      invalidate()
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to grant'),
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows ?? []
    return (rows ?? []).filter(
      (r) =>
        r.account.name.toLowerCase().includes(q) ||
        r.account.account_code.toLowerCase().includes(q) ||
        (r.granted_to?.name ?? '').toLowerCase().includes(q),
    )
  }, [rows, search])

  const grantedCount = (rows ?? []).filter((r) => r.granted_to).length

  return (
    <div>
      <PageHeader
        title="Ad Account Pool"
        description="Accounts the platform owns centrally and grants to agencies."
      >
        <Button onClick={() => setImportOpen(true)}>
          <Download className="size-4" />
          Add from Meta
        </Button>
      </PageHeader>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Pool accounts" value={(rows?.length ?? 0).toLocaleString()} />
        <StatCard label="Granted" value={grantedCount.toLocaleString()} />
        <StatCard
          label="Unassigned"
          value={((rows?.length ?? 0) - grantedCount).toLocaleString()}
        />
      </div>

      <Input
        placeholder="Search by account, code, or agency..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 sm:max-w-xs"
      />

      {isLoading && <Skeleton className="h-64 w-full" />}

      {!isLoading && (
        <Card className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Code</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Current limit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Granted to</TableHead>
                <TableHead className="w-10 pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                      <Megaphone className="size-7 opacity-40" />
                      {rows?.length === 0
                        ? 'No accounts in the pool yet.'
                        : 'No accounts match that search.'}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((row) => (
                <TableRow key={row.account.id}>
                  <TableCell className="pl-6 font-mono text-xs">
                    {row.account.account_code}
                  </TableCell>
                  <TableCell className="font-medium">{row.account.name}</TableCell>
                  <TableCell className="num">
                    {formatUsd(row.account.current_limit_usd)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.account.status} />
                  </TableCell>
                  <TableCell>
                    {row.granted_to ? (
                      <Badge variant="secondary">{row.granted_to.name}</Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-8">
                          <MoreHorizontal className="size-4" />
                          <span className="sr-only">
                            Actions for {row.account.name}
                          </span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {row.granted_to ? (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() =>
                              setToRevoke({
                                adAccountId: row.account.id,
                                accountLabel: `${row.account.account_code} "${row.account.name}"`,
                                agencyName: row.granted_to!.name,
                              })
                            }
                          >
                            Revoke from {row.granted_to.name}
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuLabel>Grant to</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {(organizations ?? []).map((org) => (
                              <DropdownMenuItem
                                key={org.id}
                                disabled={grantMutation.isPending}
                                onClick={() =>
                                  grantMutation.mutate({
                                    ad_account_id: row.account.id,
                                    organization_id: org.id,
                                  })
                                }
                              >
                                {org.name}
                              </DropdownMenuItem>
                            ))}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <PoolImportDialog open={importOpen} onOpenChange={setImportOpen} />

      <RevokeGrantDialog
        grant={toRevoke}
        open={toRevoke !== null}
        onOpenChange={(o) => !o && setToRevoke(null)}
      />

      <p className="mt-4 text-xs text-muted-foreground">
        One agency at a time per account. Granting is push-only — agencies
        cannot browse or request pool accounts.
      </p>
    </div>
  )
}
