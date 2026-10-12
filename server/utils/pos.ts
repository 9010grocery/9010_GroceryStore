// Server copy of src/lib/pos.ts computeTotals: the server recomputes every sale from its own prices,
// so a terminal can't send its own totals. Keep the two in step.

export type CustomerType = 'Regular' | 'Senior' | 'PWD'

export const round2 = (value: number) => Math.round(value * 100) / 100

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

/** Store-local DATETIME string from MySQL ("2026-10-06 08:00:12", UTC+8) → ISO string for the UI. */
export function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(`${value.replace(' ', 'T')}${value.length <= 10 ? 'T00:00:00' : ''}+08:00`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}