import { formatBdt, formatUsd } from '@/lib/money/money'
import { Card, CardContent, CardDescription } from '@/components/ui/card'
import type { ClientFinancials } from '@/types/domain'

/** Client financial summary cards (spec §34, §66, §69). Ledger-derived. */
export function FinancialSummary({
  financials,
}: {
  financials: ClientFinancials
}) {
  const cards = [
    { label: 'Total Approved (USD)', value: formatUsd(financials.total_approved_usd) },
    { label: 'Total Billed (BDT)', value: formatBdt(financials.total_debit) },
    { label: 'Total Paid (BDT)', value: formatBdt(financials.total_credit) },
    {
      label: 'Current Due (BDT)',
      value: formatBdt(financials.current_due),
      emphasize: true,
    },
    {
      label: 'Current Due (USD, approx.)',
      value: formatUsd(financials.current_due_usd),
      subValue: 'converted at the current USD rate',
      emphasize: true,
    },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="py-4">
            <CardDescription>{c.label}</CardDescription>
            <div
              className={
                c.emphasize
                  ? 'mt-1 text-2xl font-semibold text-foreground'
                  : 'mt-1 text-2xl font-semibold'
              }
            >
              {c.value}
            </div>
            {c.subValue && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {c.subValue}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
