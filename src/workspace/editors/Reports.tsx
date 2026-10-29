import { useState } from 'react'
import { useServerData } from '../../hooks/useServerData'
import { peso } from '../../lib/format'
import {
  apiErrorMessage, downloadReport, getAdminTerminals, getGrandTotal, getReport, getReportShifts, getXReading, postXReading, postZReading,
  type ReportCell, type ReportDoc, type ReportKind, type ReportParams, type ReportShift,
} from '../../services/api'
import { useStore } from '../../store/StoreContext'
import { Empty, Modal, Segmented } from '../ui'

// Report Center (spec Module 10): every number comes from the store's database through /api/reports, and the PDF and CSV
// files are made by the server from the same report, so the screen, the printout and the files always agree.

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000))

type ReportType = 'x-reading' | 'z-reading' | 'e-journal' | 'vat-summary' | 'sales' | 'inventory' | 'waste' | 'purchasing' | 'requests'

const catalog: { type: ReportType; name: string; description: string; tag: string; icon: string }[] = [
  { type: 'x-reading', name: 'X-Reading', description: 'Sales of one cashier shift', tag: 'SHIFT REPORT', icon: '↗' },
  { type: 'z-reading', name: 'Z-Reading', description: 'Close of the day, all terminals', tag: 'DAILY CLOSE', icon: '▥' },
  { type: 'e-journal', name: 'e-Journal', description: 'Every sale, void and refund', tag: 'BIR COMPLIANT', icon: '≡' },
  { type: 'vat-summary', name: 'VAT Summary', description: 'Output tax by day', tag: 'TAX SUMMARY', icon: '₱' },
  { type: 'sales', name: 'Sales Report', description: 'By day, cashier, terminal, payment or product', tag: 'OPERATIONS', icon: '▤' },
  { type: 'inventory', name: 'Inventory', description: 'Stock on hand and stock movements', tag: 'INVENTORY', icon: '◫' },
  { type: 'waste', name: 'Waste Report', description: 'Write-offs by reason and item', tag: 'LOSS PREVENTION', icon: '⌁' },
  { type: 'purchasing', name: 'Purchasing', description: 'Purchase orders and deliveries', tag: 'SUPPLY', icon: '⇄' },
  { type: 'requests', name: 'Customer Requests', description: 'What customers ask for', tag: 'DEMAND', icon: '♙' },
]

const fmt = (value: ReportCell, kind: ReportKind): string => {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') return value
  if (kind === 'money') return peso(value)
  if (kind === 'pct') return `${value.toFixed(1)}%`
  if (kind === 'int') return value.toLocaleString('en-PH')
  return String(value)
}

const stamp = (iso: string) => new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })

type Open = { type: ReportType; params: ReportParams }

export function ReportsPanel() {
  const { state } = useStore()
  const live = state.source === 'live'
  const [from, setFrom] = useState(daysAgo(6))
  const [to, setTo] = useState(ymd(new Date()))
  const [productId, setProductId] = useState('')
  const [cashierId, setCashierId] = useState('')
  const [terminalId, setTerminalId] = useState('')
  const [open, setOpen] = useState<Open | null>(null)
  const [pickShift, setPickShift] = useState(false)
  const rangeOk = from <= to
  const terminals = useServerData(live, getAdminTerminals, [])
  const grand = useServerData(live, getGrandTotal, [open === null, state.liveSyncedAt])
  const preset = (days: number, endDaysAgo = 0) => { setFrom(daysAgo(days - 1 + endDaysAgo)); setTo(daysAgo(endDaysAgo)) }
  const params: ReportParams = { from, to, product_id: productId || undefined, cashier_id: cashierId || undefined, terminal_id: terminalId || undefined }

  const start = (type: ReportType) => {
    if (!rangeOk) return
    if (type === 'x-reading') { setPickShift(true); return }
    if (type === 'z-reading') { setOpen({ type, params: { date: to } }); return }
    setOpen({ type, params: { ...params, group: type === 'sales' ? 'day' : undefined } })
  }

  if (!live) return <div className="module-panel reports-panel"><Empty>Reports are made from the store server's data. Connect to the server (Settings → Server) to use them.</Empty></div>
  const g = grand.data
  return <div className="module-panel reports-panel">
    <div className="module-intro"><div><span className="eyebrow">REPORT CENTER</span><h2>Reports &amp; compliance</h2><p>BIR-style readings and operating reports for {state.settings.businessName || 'the store'}. Pick a date range and filters, then open a report. Each one can be printed or saved as PDF or CSV.</p></div></div>
    <div className="reports-grandtotal" aria-label="Accumulated grand total">
      <div><span>ACCUMULATED GRAND TOTAL</span><b>{g ? peso(g.accumulated_total) : '—'}</b><small>sales only ever add to this; voids never take from it</small></div>
      <div><span>VOIDS TO DATE</span><b>{g ? peso(g.accumulated_voids) : '—'}</b></div>
      <div><span>REFUNDS TO DATE</span><b>{g ? peso(g.accumulated_refunds) : '—'}</b></div>
      <div><span>LAST Z-READING</span><b>{g?.last_z_no ? `No. ${String(g.last_z_no).padStart(6, '0')}` : 'none yet'}</b><small>{g?.last_z_date ?? 'close a day to create one'}</small></div>
    </div>
    <div className="filter-bar">
      <label className="filter-field"><span>FROM</span><input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="filter-field"><span>TO</span><input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
      <div className="filter-presets"><button className="outline-button" onClick={() => preset(1)}>TODAY</button><button className="outline-button" onClick={() => preset(1, 1)}>YESTERDAY</button><button className="outline-button" onClick={() => preset(7)}>7 DAYS</button><button className="outline-button" onClick={() => preset(30)}>30 DAYS</button></div>
      <label className="filter-field"><span>PRODUCT</span><select aria-label="Filter by product" value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">All products</option>{state.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="filter-field"><span>EMPLOYEE</span><select aria-label="Filter by employee" value={cashierId} onChange={(e) => setCashierId(e.target.value)}><option value="">All employees</option>{state.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <label className="filter-field"><span>TERMINAL</span><select aria-label="Filter by terminal" value={terminalId} onChange={(e) => setTerminalId(e.target.value)}><option value="">All terminals</option>{(terminals.data ?? []).map((t) => <option key={t.terminal_id} value={t.terminal_id}>{t.terminal_id}{t.terminal_name ? ` · ${t.terminal_name}` : ''}</option>)}</select></label>
    </div>
    {!rangeOk && <p className="form-error">The start date is after the end date.</p>}
    <p className="muted-text reports-note">Filters apply to the Sales, e-Journal, VAT, Inventory, Waste, Purchasing and Requests reports. X- and Z-Readings are always complete: one shift, or one whole day.</p>
    <div className="report-grid">{catalog.map((c) => <button className="report-card" key={c.type} disabled={!rangeOk} onClick={() => start(c.type)}><span className="report-icon">{c.icon}</span><span className="report-tag">{c.tag}</span><b>{c.name}</b><small>{c.description}</small><i>OPEN ›</i></button>)}</div>
    {pickShift && <ShiftPicker from={from} to={to} onClose={() => setPickShift(false)} onPick={(s) => { setPickShift(false); setOpen({ type: 'x-reading', params: { session_id: `s${s.session_id}` } }) }} />}
    {open && <ReportViewer key={`${open.type}-${JSON.stringify(open.params)}`} open={open} onClose={() => setOpen(null)} onChange={setOpen} />}
  </div>
}

function ShiftPicker({ from, to, onClose, onPick }: { from: string; to: string; onClose: () => void; onPick: (shift: ReportShift) => void }) {
  const shifts = useServerData(true, () => getReportShifts(from, to), [from, to])
  return <Modal wide title="X-Reading · choose a shift" eyebrow={`${from} TO ${to}`} onClose={onClose}>
    {shifts.error && <p className="form-error">{shifts.error}</p>}
    {shifts.loading && !shifts.data && <p className="muted-text">Loading shifts…</p>}
    {shifts.data && shifts.data.length === 0 && <Empty>No cashier shifts in this date range.</Empty>}
    {shifts.data && shifts.data.length > 0 && <div className="data-table-wrap"><table className="data-table"><thead><tr>{['CASHIER', 'TERMINAL', 'STARTED', 'ENDED', 'RECEIPTS', ''].map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{shifts.data.map((s) => <tr key={s.session_id} className="clickable-row" onClick={() => onPick(s)}>
        <td><b>{s.cashier}</b></td><td>{s.terminal_id}</td><td>{stamp(s.start)}</td><td>{s.end ? stamp(s.end) : <span className="status-pill open">ON SHIFT</span>}</td><td>{s.receipts}</td>
        <td><button className="outline-button" onClick={(e) => { e.stopPropagation(); onPick(s) }}>{s.has_reading ? 'OPEN SAVED ›' : 'OPEN ›'}</button></td></tr>)}</tbody></table></div>}
  </Modal>
}

const groups = [['day', 'By day'], ['cashier', 'By cashier'], ['terminal', 'By terminal'], ['payment', 'By payment'], ['product', 'By product']] as const

function ReportViewer({ open, onClose, onChange }: { open: Open; onClose: () => void; onChange: (open: Open) => void }) {
  const { actions } = useStore()
  const [version, setVersion] = useState(0)
  const doc = useServerData<ReportDoc>(true, () => (open.type === 'x-reading' ? getXReading(Number(String(open.params.session_id).replace(/^s/, ''))) : getReport(open.type, open.params)), [version])
  const [busy, setBusy] = useState<'pdf' | 'csv' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  // After saving by hand, the saved copy replaces the live view.
  const [saved, setSaved] = useState<ReportDoc | null>(null)
  const d = saved ?? doc.data
  const reading = d?.reading
  const title = catalog.find((c) => c.type === open.type)?.name ?? open.type

  async function download(format: 'pdf' | 'csv') {
    setBusy(format); setError(null)
    try { await downloadReport(open.type, open.params, format) } catch (e) { setError(apiErrorMessage(e)) } finally { setBusy(null) }
  }
  async function saveX() {
    setBusy('save'); setError(null)
    try { setSaved(await postXReading(Number(String(open.params.session_id).replace(/^s/, '')))); actions.toast('X-Reading saved') } catch (e) { setError(apiErrorMessage(e)) } finally { setBusy(null) }
  }
  async function closeDay() {
    setBusy('save'); setError(null)
    try { const z = await postZReading(open.params.date!); setConfirmClose(false); setVersion((v) => v + 1); actions.toast(z.already_closed ? 'That day was already closed' : `Z-Reading No. ${String(z.reading?.reading_no ?? 0).padStart(6, '0')} saved`) } catch (e) { setError(apiErrorMessage(e)); setConfirmClose(false) } finally { setBusy(null) }
  }

  const footer = <>
    {error && <span className="confirm-text error" role="alert">{error}</span>}
    {open.type === 'z-reading' && reading && !reading.stored && (confirmClose
      ? <><span className="confirm-text">Save the Z-Reading for {open.params.date}? It closes the day and can't be changed.</span><button className="outline-button" disabled={busy !== null} onClick={() => setConfirmClose(false)}>CANCEL</button><button className="primary-button" disabled={busy !== null} onClick={() => void closeDay()}>YES, CLOSE THE DAY</button></>
      : <button className="outline-button" disabled={busy !== null} onClick={() => setConfirmClose(true)}>CLOSE THE DAY…</button>)}
    {open.type === 'x-reading' && reading && !reading.stored && <button className="outline-button" disabled={busy !== null} onClick={() => void saveX()}>SAVE THIS X-READING</button>}
    <button className="outline-button" disabled={busy !== null || !d} onClick={() => void download('csv')}>{busy === 'csv' ? 'PREPARING…' : '↓ CSV'}</button>
    <button className="outline-button" disabled={busy !== null || !d} onClick={() => void download('pdf')}>{busy === 'pdf' ? 'PREPARING…' : '↓ PDF'}</button>
    <button className="primary-button" disabled={!d} onClick={() => window.print()}>PRINT ⎙</button>
  </>

  return <Modal wide title={`${title}${reading?.reading_no ? ` No. ${String(reading.reading_no).padStart(6, '0')}` : ''}`} eyebrow={(d?.business.name || 'REPORT').toUpperCase()} onClose={onClose} footer={footer}>
    <div className="report-controls">
      {open.type === 'sales' && <Segmented label="Group sales" options={groups.map((x) => x[1])} value={groups.find((x) => x[0] === open.params.group)?.[1] ?? 'By day'} onChange={(label) => onChange({ ...open, params: { ...open.params, group: groups.find((x) => x[1] === label)![0] } })} />}
      {open.type === 'z-reading' && <label className="filter-field"><span>DAY</span><input type="date" aria-label="Z-Reading day" value={open.params.date} max={ymd(new Date())} onChange={(e) => e.target.value && onChange({ ...open, params: { date: e.target.value } })} /></label>}
      {reading && <span className={`status-pill ${reading.stored ? 'completed' : 'open'}`}>{reading.stored ? (reading.source === 'end_of_shift' ? 'SAVED WHEN SHIFT ENDED' : 'SAVED') : open.type === 'z-reading' ? 'PREVIEW · DAY NOT CLOSED' : 'LIVE · NOT SAVED'}</span>}
    </div>
    {error && <p className="form-error">{error}</p>}
    {doc.error && <p className="form-error">{doc.error}</p>}
    {doc.loading && !d && <p className="muted-text">Building the report…</p>}
    {d && <div className="print-area report-print">
      <header className="report-letterhead"><b>{d.business.name || '9010 Grocery Store'}</b>{d.business.tin && <span>TIN {d.business.tin}</span>}{d.business.address && <span>{d.business.address}</span>}<h3>{d.title}{reading?.reading_no ? ` No. ${String(reading.reading_no).padStart(6, '0')}` : ''}</h3><span>Period: {d.period}</span>{d.filters.map((f) => <span key={f}>{f}</span>)}</header>
      {d.summary.length > 0 && <div className="report-summary">{d.summary.map((s) => <div key={s.label}><span>{s.label}</span><b>{fmt(s.value, s.kind) || '—'}</b></div>)}</div>}
      {d.tables.map((t, i) => <section className="report-table" key={i}>
        {t.title && <h4>{t.title}</h4>}
        <div className="data-table-wrap"><table className="data-table"><thead><tr>{t.columns.map((c) => <th key={c.label} className={c.kind === 'text' ? '' : 'num'}>{c.label.toUpperCase()}</th>)}</tr></thead>
          <tbody>{t.rows.map((row, r) => <tr key={r} className={String(row[0]).toUpperCase() === 'NET SALES' ? 'row-strong' : ''}>{row.map((cell, c) => <td key={c} className={t.columns[c]!.kind === 'text' ? '' : 'num'}>{c === 0 ? <b>{fmt(cell, t.columns[c]!.kind)}</b> : fmt(cell, t.columns[c]!.kind)}</td>)}</tr>)}
            {t.rows.length === 0 && <tr><td colSpan={t.columns.length} className="muted-text">No records for this period.</td></tr>}
            {t.totals && <tr className="row-strong totals">{t.totals.map((cell, c) => <td key={c} className={t.columns[c]!.kind === 'text' ? '' : 'num'}>{fmt(cell, t.columns[c]!.kind)}</td>)}</tr>}</tbody></table></div>
      </section>)}
      <p className="muted-text">Generated by {d.generated_by} · {stamp(d.generated_at)}</p>
    </div>}
  </Modal>
}