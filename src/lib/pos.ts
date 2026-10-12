import type { CustomerType } from '../data/types'

// Keep in step with server/utils/pos.ts: the server recomputes every sale itself; this copy only shows the cashier the total.

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * Shelf prices are VAT-inclusive.
 *
 * Regular customers: the cashier may discount individual items (`discountPercent` on a line, or `manualPercent` for
 * every line that has none). The discount comes off the VAT-inclusive price, and the VAT inside what is left is
 * worked out from the new total. Above the store's threshold the owner's PIN is needed (checked by the caller).
 *
 * Senior citizens and PWDs (RA 9994 / RA 10754): items marked `discountable` (the default) are made VAT-exempt and get
 * 20% off the VAT-exclusive price; any other item is charged at its full VAT-inclusive price. A cashier discount
 * is not added on top.
 *
 * `lineNets` is what each line costs the customer after every discount; it always adds up to `total`, and a refund of
 * that line gives back its share of it.
 */
export interface TotalsLine { price: number; qty: number; discountable?: boolean; discountPercent?: number | null; discountAmount?: number | null }

export function computeTotals(lines: TotalsLine[], customerType: CustomerType, vatRate: number, manualPercent = 0) {
  const gross = round2(lines.reduce((sum, line) => sum + line.price * line.qty, 0))
  const fixLast = (nets: number[], total: number) => {
    // Rounding each line can leave the lines a cent away from the total; the last line takes the difference.
    if (nets.length) nets[nets.length - 1] = round2(nets[nets.length - 1] + (total - round2(nets.reduce((a, b) => a + b, 0))))
    return nets
  }
  if (customerType === 'Regular') {
    const nets = lines.map((line) => {
      const percent = line.discountPercent ?? manualPercent
      const lineGross = round2(line.price * line.qty)
      // `discountAmount` (peso amount off, e.g. a batch markdown) wins over a percent when both are given.
      if (line.discountAmount !== undefined && line.discountAmount !== null) return round2(lineGross - Math.min(lineGross, Math.max(0, line.discountAmount)))
      return round2(lineGross - (percent > 0 ? round2(lineGross * (percent / 100)) : 0))
    })
    const total = round2(nets.reduce((sum, n) => sum + n, 0))
    return { gross, lessVat: 0, discount: round2(gross - total), vat: round2(total - total / (1 + vatRate)), vatExempt: 0, total, lineNets: nets }
  }
  const eligible = round2(lines.filter((l) => l.discountable !== false).reduce((sum, l) => sum + l.price * l.qty, 0))
  const other = round2(gross - eligible)
  const base = eligible / (1 + vatRate)
  const discount = round2(base * 0.2)
  const total = round2(base - discount + other)
  const nets = lines.map((line) => {
    const lineGross = round2(line.price * line.qty)
    return line.discountable !== false ? round2((lineGross / (1 + vatRate)) * 0.8) : lineGross
  })
  return {
    gross,
    lessVat: round2(eligible - base),
    discount,
    vat: round2(other - other / (1 + vatRate)),
    vatExempt: round2(base),
    total,
    lineNets: fixLast(nets, total),
  }
}

export function quickCashOptions(total: number) {
  const options = new Set<number>([Math.ceil(total)])
  for (const bill of [50, 100, 200, 500, 1000]) {
    const rounded = Math.ceil(total / bill) * bill
    if (rounded >= total) options.add(rounded)
  }
  return [...options].sort((a, b) => a - b).slice(0, 5)
}

/** Peso markdown for `qty` units, taken from the batches in selling order (soonest expiry first). Mirror of the server's batchMarkdown. */
export function batchMarkdown(product: { price: number; batches?: { qty: number; markdownPercent: number }[] }, qty: number) {
  let remaining = qty
  let amount = 0
  for (const batch of product.batches ?? []) {
    if (remaining <= 0) break
    const take = Math.min(remaining, batch.qty)
    amount += take * product.price * (batch.markdownPercent / 100)
    remaining -= take
  }
  return round2(amount)
}

/** How many of `qty` units come from marked-down batches, and the percent when they all share one (null when the percents differ). */
export function batchMarkdownUnits(product: { batches?: { qty: number; markdownPercent: number }[] }, qty: number) {
  let remaining = qty
  let units = 0
  const percents = new Set<number>()
  for (const batch of product.batches ?? []) {
    if (remaining <= 0) break
    const take = Math.min(remaining, batch.qty)
    if (batch.markdownPercent > 0 && take > 0) { units += take; percents.add(batch.markdownPercent) }
    remaining -= take
  }
  return { units, percent: percents.size === 1 ? [...percents][0] : null }
}