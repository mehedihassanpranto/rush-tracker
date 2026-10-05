import { formatBdt, formatUsd } from '@/lib/money/money'
import { clientPayableView, receivableView } from '@/lib/money/net-due'
import type { NetDueFigures } from '@/lib/money/net-due'
import { StatCard } from '@/components/shared/stat-card'

const DUE = 'text-red-600 dark:text-red-400'
const CLEAR = 'text-emerald-600 dark:text-emerald-400'

function unreadNote(f: NetDueFigures | undefined): string {
  if (!f || f.unreadAccounts === 0) return ''
  return ` · Meta figures missing for ${f.unreadAccounts} account${f.unreadAccounts === 1 ? '' : 's'}`
}

/**
 * Gross due, unused ad credit and the net of the two (src/lib/money/net-due.ts),
 * worded for who's reading:
 *  - client: Amount Payable (never below $0; a surplus shows as a credit
 *    balance), Outstanding, Available Ad Credit;
 *  - agency/platform: Net Receivable (or Net Credit when negative), Gross
 *    Receivable, Unused Ad Balance — with the BDT equivalents as hints.
 */
export function NetDueCards({
  audience,
  figures,
  loading = false,
}: {
  audience: 'client' | 'agency'
  figures: NetDueFigures | undefined
  loading?: boolean
}) {
  const busy = loading || !figures
  if (audience === 'client') {
    const view = figures ? clientPayableView(figures.netUsd) : null
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          highlight
          label="Amount Payable"
          hint={
            view?.creditBalance
              ? `Credit balance ${formatUsd(view.creditBalance)} — your ad credit is more than you owe`
              : `Outstanding minus your available ad credit${unreadNote(figures)}`
          }
          value={view ? formatUsd(view.payable) : '—'}
          valueClassName={view ? (Number(view.payable) > 0 ? DUE : CLEAR) : ''}
          loading={busy}
        />
        <StatCard
          label="Outstanding"
          hint="Billed minus paid, in USD (approx.)"
          value={figures ? formatUsd(figures.grossDueUsd) : '—'}
          loading={busy}
        />
        <StatCard
          label="Available Ad Credit"
          hint="Unused balance on your ad accounts"
          value={figures ? formatUsd(figures.adCreditUsd) : '—'}
          loading={busy}
        />
      </div>
    )
  }

  const view = figures ? receivableView(figures.netUsd) : null
  const netBdt = figures ? receivableView(figures.netBdt) : null
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatCard
        highlight
        label={view?.kind === 'credit' ? 'Net Credit (USD)' : 'Net Receivable (USD)'}
        hint={
          view?.kind === 'credit'
            ? `Unused ad balance exceeds the due · ≈ ${formatBdt(netBdt!.amount)}${unreadNote(figures)}`
            : `Gross minus unused ad balance · ≈ ${netBdt ? formatBdt(netBdt.amount) : '—'}${unreadNote(figures)}`
        }
        value={view ? formatUsd(view.amount) : '—'}
        valueClassName={view ? (view.kind === 'receivable' && Number(view.amount) > 0 ? DUE : CLEAR) : ''}
        loading={busy}
      />
      <StatCard
        label="Gross Receivable (USD)"
        hint={`Billed minus paid · ${figures ? formatBdt(figures.grossDueBdt) : '—'}`}
        value={figures ? formatUsd(figures.grossDueUsd) : '—'}
        loading={busy}
      />
      <StatCard
        label="Client Credit / Unused Ad Balance (USD)"
        hint={`Spend cap minus spent, active accounts · ≈ ${figures ? formatBdt(figures.adCreditBdt) : '—'}`}
        value={figures ? formatUsd(figures.adCreditUsd) : '—'}
        loading={busy}
      />
    </div>
  )
}
