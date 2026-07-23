import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Search } from 'lucide-react'

import { globalSearchFn } from '@/server/search/search.fns'
import { PageHeader } from '@/components/shared/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/admin/search/')({
  validateSearch: (search: Record<string, unknown>): { q: string } => ({
    q: typeof search.q === 'string' ? search.q : '',
  }),
  component: SearchPage,
})

function ResultGroup({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          {title} <span className="text-muted-foreground">({count})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">{children}</ul>
      </CardContent>
    </Card>
  )
}

function Row({
  primary,
  secondary,
}: {
  primary: React.ReactNode
  secondary?: React.ReactNode
}) {
  return (
    <li className="flex items-center justify-between py-2">
      <span className="text-primary underline-offset-4 group-hover:underline">
        {primary}
      </span>
      {secondary && (
        <span className="font-mono text-xs text-muted-foreground">
          {secondary}
        </span>
      )}
    </li>
  )
}

function SearchPage() {
  const { q } = Route.useSearch()
  const navigate = useNavigate()
  const doSearch = useServerFn(globalSearchFn)
  const [term, setTerm] = useState(q)

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['global-search', q],
    queryFn: () => doSearch({ data: { q } }),
    enabled: q.trim().length >= 2,
  })

  const total = data
    ? data.clients.length +
      data.accounts.length +
      data.limitRequests.length +
      data.payments.length +
      data.paymentRequests.length
    : 0

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const next = term.trim()
    if (next.length < 2) return
    void navigate({ to: '/admin/search', search: { q: next } })
  }

  return (
    <div>
      <PageHeader
        title="Search"
        description="Find clients, ad accounts and documents by name, code or number."
      />

      <form onSubmit={submit} className="mb-6 flex max-w-xl gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search…"
            className="pl-8"
          />
        </div>
        <Button type="submit">Search</Button>
      </form>

      {q.trim().length < 2 && (
        <p className="text-sm text-muted-foreground">
          Type at least 2 characters to search.
        </p>
      )}

      {q.trim().length >= 2 && (isLoading || isFetching) && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {q.trim().length >= 2 && !isLoading && !isFetching && total === 0 && (
        <Card className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
          <Search className="size-8 opacity-40" />
          No results for “{q}”.
        </Card>
      )}

      {data && total > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ResultGroup title="Clients" count={data.clients.length}>
            {data.clients.map((c) => (
              <Link
                key={c.id}
                to="/admin/clients/$clientId"
                params={{ clientId: c.id }}
                className="group block"
              >
                <Row primary={c.name} secondary={c.client_code} />
              </Link>
            ))}
          </ResultGroup>

          <ResultGroup title="Ad Accounts" count={data.accounts.length}>
            {data.accounts.map((a) => (
              <Link
                key={a.id}
                to="/admin/ad-accounts/$accountId"
                params={{ accountId: a.id }}
                className="group block"
              >
                <Row
                  primary={a.name}
                  secondary={a.external_account_id ?? a.account_code}
                />
              </Link>
            ))}
          </ResultGroup>

          <ResultGroup title="Limit Requests" count={data.limitRequests.length}>
            {data.limitRequests.map((r) => (
              <Link
                key={r.id}
                to="/admin/limit-requests/$requestId"
                params={{ requestId: r.id }}
                className="group block"
              >
                <Row primary={r.request_number} />
              </Link>
            ))}
          </ResultGroup>

          <ResultGroup title="Payments" count={data.payments.length}>
            {data.payments.map((p) => (
              <Link
                key={p.id}
                to="/admin/payments/$paymentId"
                params={{ paymentId: p.id }}
                className="group block"
              >
                <Row primary={p.payment_number} />
              </Link>
            ))}
          </ResultGroup>

          <ResultGroup
            title="Payment Requests"
            count={data.paymentRequests.length}
          >
            {data.paymentRequests.map((r) => (
              <Link key={r.id} to="/admin/payment-requests" className="group block">
                <Row primary={r.request_number} />
              </Link>
            ))}
          </ResultGroup>
        </div>
      )}
    </div>
  )
}
