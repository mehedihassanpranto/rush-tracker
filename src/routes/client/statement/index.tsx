import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'

import { getMyStatementFn } from '@/server/ledger/ledger.fns'
import { myNetPayableFn } from '@/server/finance/net-due.fns'
import { PageHeader } from '@/components/shared/page-header'
import { FinancialSummary } from '@/components/shared/financial-summary'
import { LedgerTable } from '@/components/shared/ledger-table'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/client/statement/')({
  component: StatementPage,
})

function StatementPage() {
  const getStatement = useServerFn(getMyStatementFn)
  const { data, isLoading } = useQuery({
    queryKey: ['my-statement'],
    queryFn: () => getStatement(),
  })
  const getNetPayable = useServerFn(myNetPayableFn)
  const { data: netPayable, isLoading: netLoading } = useQuery({
    queryKey: ['my-net-payable'],
    queryFn: () => getNetPayable(),
    retry: false,
  })

  return (
    <div>
      <PageHeader
        title="Statement"
        description="Your billing and payment history. Current due is the running balance."
      />

      {isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-6">
          <FinancialSummary
            financials={data.financials}
            net={{ audience: 'client', figures: netPayable, loading: netLoading }}
          />
          <LedgerTable entries={data.entries} />
        </div>
      )}
    </div>
  )
}
