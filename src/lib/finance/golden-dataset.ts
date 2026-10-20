/**
 * Finance v2 golden dataset (plan v2 "Test plan"). One scenario, computed BY
 * HAND first and written down here; every engine and report test asserts
 * against these figures. If a code change moves one of them, the code is
 * wrong until someone re-derives the number on paper — never "update the
 * fixture to match".
 *
 * The working is in docs/FINANCE_V2_MILESTONE0.md §5. Rates are BDT per USD.
 *
 * Batches (posting order):
 * A batch costs exactly the BDT that left your accounts (principal + the bank
 * fee you bear). The supplier prices on net USD, so you pay for the dollars
 * that land plus your share of the USD fee; the fee's cost is then inside the
 * effective rate, never added on top.
 *
 *   B1  Binance, gross 1,000.00, fee 0.01 (yours) → net 999.99 @ 126.00
 *       paid (999.99 + 0.01) × 126 = 126,000.00; DBBL → DBBL, BDT 0
 *                                                       cost 126,000.00
 *   B2  Payoneer, gross 500.00, fee 10.00 (yours 4.00, supplier 6.00)
 *       → net 490.00 @ 128.50; paid (490 + 4) × 128.5 = 63,479.00;
 *       DBBL → BRAC by NPSB, BDT 10                      cost  63,489.00
 *   B3  Binance, gross 300.00, fee 0.01 → net 299.99 @ 130.00
 *       paid 300 × 130 = 39,000.00; DBBL → DBBL           cost  39,000.00
 *   B4  Binance, gross 100.00 @ 127 — posted by mistake, reversed untouched.
 *
 * Outgoing (posting order):
 *   1  Fund prepaid Meta account P with 700.00   → all from B1
 *   2  Settle postpaid Meta account Q's 450.00 spend → rest of B1 + 150.01 of B2
 *   3  P spends 650.00 against its own funded lot
 *   Client X allocated 700.00 on P @ 135.00; client Y allocated 450.00 on Q
 *   @ 132.00; client X pays BDT 50,000.
 */

export const GOLDEN = {
  batches: {
    B1: { gross_usd: '1000', principal: '126000.00', net_usd: '999.990000', fees_bdt: '0.00', cost: '126000.00', rate: '126.000000' },
    B2: { gross_usd: '500', principal: '63479.00', net_usd: '490.000000', fees_bdt: '10.00', cost: '63489.00', rate: '128.500000' },
    B3: { gross_usd: '300', principal: '39000.00', net_usd: '299.990000', fees_bdt: '0.00', cost: '39000.00', rate: '130.000000' },
    B4: { gross_usd: '100', principal: '12700.00', net_usd: '99.990000', fees_bdt: '0.00', cost: '12700.00', rate: '127.000000' },
  },
  /** Step 1: 700 × 126,000 ÷ 999.99 = 88,200.882… → 88,200.88 */
  prepaidFunding: { usd: '700', bdt: '88200.88', b1_left_usd: '299.990000', b1_left_bdt: '37799.12' },
  /** Step 2: B1's remaining 299.99 (= its 37,799.12 left, exactly) + 150.01 of
   * B2 (150.01 × 63,489 ÷ 490 = 19,436.704… → 19,436.70). */
  postpaidSettlement: {
    usd: '450',
    allocations: [
      { lot_id: 'B1', usd: '299.990000', bdt: '37799.12' },
      { lot_id: 'B2', usd: '150.010000', bdt: '19436.70' },
    ],
    bdt: '57235.82',
  },
  /** Step 3: 650 × 88,200.88 ÷ 700 = 81,900.817… → 81,900.82 */
  prepaidSpend: { usd: '650', bdt: '81900.82', left_usd: '50.000000', left_bdt: '6300.06' },
  closingInventory: {
    usd: '639.980000', // 339.99 (B2) + 299.99 (B3)
    bdt: '83052.30', // 44,052.30 (B2) + 39,000.00 (B3)
    reconciles: { purchased_bdt: '228489.00', consumed_bdt: '145436.70' },
  },
  revenue: {
    clientX: { usd: '700', rate: '135', bdt: '94500.00' },
    clientY: { usd: '450', rate: '132', bdt: '59400.00' },
    total_bdt: '153900.00',
  },
  receivables: { clientX_after_payment: '44500.00', clientY: '59400.00' },
  /** Cost recognized in the period: prepaid spend + postpaid cost. The
   * postpaid half assumes its cost is the settlement's FIFO cost — an open
   * decision (Milestone 0 doc, Q3). */
  grossProfit: { cost_bdt: '139136.64', profit_bdt: '14763.36' },
  /** Allocated but unspent: P's 50 USD, billed at 135 (6,750.00) while 6,300.06
   * of cost still sits in the prepaid asset. Shown as its own report line. */
  allocatedUnspent: { usd: '50', revenue_bdt: '6750.00', cost_in_asset_bdt: '6300.06' },
} as const
