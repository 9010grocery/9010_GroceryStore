import { useMemo, useState, type ChangeEvent } from 'react'
import { downloadCsv, num } from '../../lib/format'
import { apiErrorMessage, postImport, type ImportKind, type ImportResult } from '../../services/api'
import { useStore } from '../../store/StoreContext'
import { Empty, Field, Segmented } from '../ui'
import { Select } from '../Select'

// Imports data exported from the old system. The file is read here (CSV, .xlsx, .xls), its columns are matched
// to the fields below, and the rows go to the server, which checks and saves them (server/services/import.service.ts).

interface FieldDef {
  key: string
  label: string
  required?: boolean
  hint?: string
  /** Column names old systems commonly use for this field, for automatic matching (lowercase). */
  names: string[]
  type?: 'date' | 'time'
}

const PRODUCT_REF: FieldDef[] = [
  { key: 'barcode', label: 'Barcode', names: ['barcode', 'bar code', 'upc', 'ean', 'gtin'] },
  { key: 'sku', label: 'SKU / item code', names: ['sku', 'item code', 'product code', 'code', 'plu', 'stock code', 'item no', 'item number'] },
  { key: 'name', label: 'Product name', names: ['product name', 'item name', 'name', 'product', 'item', 'description', 'item description', 'desc'] },
]

const KINDS: { kind: ImportKind; label: string; unit: string; summary: string; fields: FieldDef[] }[] = [
  {
    kind: 'products', label: 'Products & stock', unit: 'products',
    summary: 'Adds new products and updates existing ones (matched by barcode, then SKU, then name). Stock on hand replaces the current count.',
    fields: [
      ...PRODUCT_REF.map((f) => (f.key === 'name' ? { ...f, required: true, hint: 'Needed for new products' } : f)),
      { key: 'category', label: 'Category', names: ['category', 'department', 'dept', 'group', 'class'] },
      { key: 'supplier', label: 'Supplier', names: ['supplier', 'vendor', 'distributor'] },
      { key: 'unit', label: 'Unit', names: ['unit', 'uom', 'unit of measure'] },
      { key: 'price', label: 'Selling price (VAT incl.)', required: true, hint: 'Needed for new products', names: ['selling price', 'srp', 'retail price', 'price', 'sell price', 'unit price', 'retail'] },
      { key: 'cost', label: 'Unit cost', names: ['unit cost', 'cost price', 'cost', 'purchase price', 'buying price'] },
      { key: 'stock', label: 'Stock on hand', names: ['stock on hand', 'on hand', 'soh', 'stock', 'quantity', 'qty', 'inventory', 'balance'] },
      { key: 'reorder_point', label: 'Reorder level', names: ['reorder level', 'reorder point', 'reorder', 'minimum', 'min stock', 'min'] },
      { key: 'lead_time_days', label: 'Lead time (days)', names: ['lead time', 'lead time days'] },
      { key: 'expiry', label: 'Nearest expiry', type: 'date', names: ['expiry', 'expiry date', 'expiration', 'expiration date', 'exp date', 'best before'] },
      { key: 'active', label: 'Active (yes/no)', names: ['active', 'status', 'enabled'] },
    ],
  },
  {
    kind: 'employees', label: 'Employees', unit: 'employees',
    summary: 'Adds cashiers and updates existing ones (matched by email, phone, then name). Cashiers never need a PIN.',
    fields: [
      { key: 'name', label: 'Full name', hint: 'Or first and last name below', names: ['full name', 'employee name', 'name', 'employee', 'cashier'] },
      { key: 'first_name', label: 'First name', names: ['first name', 'firstname', 'given name'] },
      { key: 'last_name', label: 'Last name', names: ['last name', 'lastname', 'surname', 'family name'] },
      { key: 'email', label: 'Email', names: ['email', 'e-mail', 'email address'] },
      { key: 'phone', label: 'Phone', names: ['phone', 'mobile', 'contact', 'contact number', 'cellphone', 'cel'] },
      { key: 'status', label: 'Status', hint: 'Active, inactive / resigned, or on leave', names: ['status', 'employment status', 'active'] },
    ],
  },
  {
    kind: 'sales', label: 'Sales history', unit: 'receipts',
    summary: 'One row per item sold; rows with the same receipt number become one receipt. Receipts already in the database are skipped. Used for reports and AI forecasting; does not change current stock.',
    fields: [
      { key: 'receipt', label: 'Receipt / OR number', required: true, names: ['receipt', 'receipt no', 'receipt number', 'or no', 'or number', 'or', 'invoice', 'invoice no', 'transaction no', 'transaction id', 'txn'] },
      { key: 'date', label: 'Date', required: true, type: 'date', names: ['date', 'transaction date', 'sale date', 'datetime', 'date time'] },
      { key: 'time', label: 'Time (if separate)', type: 'time', names: ['time', 'transaction time'] },
      ...PRODUCT_REF,
      { key: 'qty', label: 'Quantity', required: true, names: ['quantity', 'qty', 'units', 'pcs', 'qty sold'] },
      { key: 'unit_price', label: 'Unit price', hint: 'Else line total ÷ qty, else current price', names: ['unit price', 'price', 'srp', 'selling price'] },
      { key: 'line_total', label: 'Line total', names: ['line total', 'amount', 'total', 'subtotal', 'net amount', 'net'] },
      { key: 'payment_method', label: 'Payment method', names: ['payment method', 'payment', 'mode of payment', 'mop', 'tender', 'tender type'] },
      { key: 'customer_type', label: 'Customer type', hint: 'Regular, Senior or PWD', names: ['customer type', 'discount type', 'discount', 'customer'] },
      { key: 'cashier', label: 'Cashier', names: ['cashier', 'cashier name', 'operator', 'clerk', 'user', 'staff'] },
      { key: 'senior_pwd_id', label: 'Senior/PWD ID no.', names: ['sc id', 'pwd id', 'osca id', 'senior id', 'id no', 'id number'] },
      { key: 'senior_pwd_name', label: 'Senior/PWD name', names: ['sc name', 'pwd name', 'senior name', 'customer name'] },
      { key: 'amount_received', label: 'Amount received', names: ['amount received', 'tendered', 'cash received', 'amount paid', 'payment amount'] },
      { key: 'reference', label: 'Payment reference', names: ['reference', 'ref no', 'reference no', 'approval code'] },
    ],
  },
  {
    kind: 'waste', label: 'Write-offs', unit: 'entries',
    summary: 'Past spoilage, damage and expiry write-offs. Exact duplicates are skipped. History only: does not change current stock.',
    fields: [
      { key: 'date', label: 'Date', required: true, type: 'date', names: ['date', 'waste date', 'date recorded'] },
      ...PRODUCT_REF,
      { key: 'qty', label: 'Quantity', required: true, names: ['quantity', 'qty', 'units', 'pcs'] },
      { key: 'reason', label: 'Reason', hint: 'Expired, damaged, spoiled, theft, return…', names: ['reason', 'type', 'waste type', 'cause'] },
      { key: 'notes', label: 'Notes', names: ['notes', 'remarks', 'comment', 'comments'] },
    ],
  },
  {
    kind: 'requests', label: 'Customer requests', unit: 'requests',
    summary: 'Items customers asked for that the store did not carry. Exact duplicates are skipped.',
    fields: [
      { key: 'item', label: 'Requested item', required: true, names: ['requested item', 'item', 'product', 'request', 'description'] },
      { key: 'date', label: 'Date', type: 'date', names: ['date', 'request date', 'date requested'] },
      { key: 'category', label: 'Category', names: ['category', 'department'] },
      { key: 'requested_by', label: 'Requested by', names: ['requested by', 'customer', 'customer name', 'name'] },
      { key: 'contact', label: 'Contact', names: ['contact', 'phone', 'mobile', 'contact number'] },
      { key: 'quantity', label: 'Quantity', names: ['quantity', 'qty'] },
      { key: 'status', label: 'Status', names: ['status'] },
      { key: 'notes', label: 'Notes', names: ['notes', 'remarks'] },
    ],
  },
]

const MAX_ROWS = 50_000
const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Picks a column for each field: exact name matches first, then columns that contain the name. Each column is used once. */
function autoMap(fields: FieldDef[], headers: string[]): Record<string, number> {
  const columns = headers.map(normalise)
  const used = new Set<number>()
  const mapping: Record<string, number> = {}
  for (const pass of ['exact', 'contains'] as const) {
    for (const field of fields) {
      if (mapping[field.key] !== undefined) continue
      for (const name of field.names) {
        const index = columns.findIndex((column, i) => !used.has(i) && column && (pass === 'exact' ? column === name : column.includes(name)))
        if (index >= 0) {
          mapping[field.key] = index
          used.add(index)
          break
        }
      }
    }
  }
  return mapping
}

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/** Turns a spreadsheet date cell into "YYYY-MM-DD HH:MM:SS". Slash dates are month-first unless dayFirst (or the first number is over 12). */
function toDate(value: unknown, dayFirst: boolean): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : stamp(value)
  const text = String(value ?? '').trim()
  if (!text) return null
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i.exec(text)
  let year: number, month: number, day: number
  if (m) [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i.exec(text)
    if (!m) {
      const parsed = new Date(text) // e.g. "Oct 6, 2026 3:15 PM"
      return Number.isNaN(parsed.getTime()) ? text : stamp(parsed)
    }
    const [a, b] = [Number(m[1]), Number(m[2])]
    const swap = dayFirst || a > 12
    ;[month, day] = swap ? [b, a] : [a, b]
    year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3])
  }
  let hour = Number(m[4] ?? 0)
  if (m[7] && /p/i.test(m[7]) && hour < 12) hour += 12
  if (m[7] && /a/i.test(m[7]) && hour === 12) hour = 0
  const date = new Date(year, month - 1, day, hour, Number(m[5] ?? 0), Number(m[6] ?? 0))
  return date.getMonth() === month - 1 ? stamp(date) : text
}

/** "3:15 PM", "15:15" or a time-only Excel cell → "HH:MM:SS". */
function toTime(value: unknown): string | null {
  if (value instanceof Date) return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(String(value ?? '').trim())
  if (!m) return null
  let hour = Number(m[1])
  if (m[4] && /p/i.test(m[4]) && hour < 12) hour += 12
  if (m[4] && /a/i.test(m[4]) && hour === 12) hour = 0
  return `${pad(hour)}:${m[2]}:${m[3] ?? '00'}`
}

interface Sheet { name: string; headers: string[]; rows: unknown[][]; headerLine: number }

async function readFile(file: File): Promise<Sheet[]> {
  const XLSX = await import('xlsx')
  const book = XLSX.read(await file.arrayBuffer(), { cellDates: true, dense: true })
  return book.SheetNames.map((name) => {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false })
    // Exports often start with a title or date line above the table, so the header is the row near the top
    // with the most filled-in text cells, not simply the first non-empty one.
    const filled = (row: unknown[]) => row.filter((cell) => typeof cell === 'string' && cell.trim() !== '').length
    let headerIndex = -1
    for (let i = 0; i < Math.min(grid.length, 20); i++) if (filled(grid[i]) > (headerIndex < 0 ? 0 : filled(grid[headerIndex]))) headerIndex = i
    if (headerIndex < 0) return { name, headers: [], rows: [], headerLine: 1 }
    return {
      name,
      headers: grid[headerIndex].map((cell, i) => (cell === null || String(cell).trim() === '' ? `Column ${i + 1}` : String(cell).trim())),
      rows: grid.slice(headerIndex + 1).filter((row) => row.some((cell) => cell !== null && String(cell).trim() !== '')),
      headerLine: headerIndex + 1,
    }
  })
}

export function DataImportPanel() {
  const { state, actions } = useStore()
  const [kind, setKind] = useState<ImportKind>('products')
  const [fileName, setFileName] = useState<string | null>(null)
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [sheetName, setSheetName] = useState('')
  const [mapping, setMapping] = useState<Record<string, number>>({})
  const [dayFirst, setDayFirst] = useState(false)
  const [busy, setBusy] = useState<'reading' | 'checking' | 'importing' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<ImportResult | null>(null)
  const [imported, setImported] = useState<ImportResult | null>(null)

  const def = KINDS.find((k) => k.kind === kind)!
  const sheet = sheets.find((s) => s.name === sheetName) ?? sheets[0]
  const isOwner = state.employees.find((e) => e.id === state.sessionId)?.role === 'Owner'

  const resetResults = () => { setChecked(null); setImported(null); setError(null) }
  const chooseKind = (next: ImportKind) => {
    setKind(next)
    resetResults()
    if (sheet) setMapping(autoMap(KINDS.find((k) => k.kind === next)!.fields, sheet.headers))
  }
  const chooseSheet = (name: string) => {
    setSheetName(name)
    resetResults()
    const next = sheets.find((s) => s.name === name)
    if (next) setMapping(autoMap(def.fields, next.headers))
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    resetResults()
    setBusy('reading')
    try {
      const read = (await readFile(file)).filter((s) => s.headers.length)
      if (!read.length) throw new Error('The file has no rows')
      setFileName(file.name)
      setSheets(read)
      setSheetName(read[0].name)
      setMapping(autoMap(def.fields, read[0].headers))
    } catch (err) {
      setError(`Couldn't read ${file.name}: ${err instanceof Error ? err.message : String(err)}. Save it as .xlsx or .csv and try again.`)
    } finally {
      setBusy(null)
    }
  }

  /** The sheet's rows as objects keyed by importer field, with dates normalised and the original line number. */
  const rows = useMemo(() => {
    if (!sheet) return []
    return sheet.rows.slice(0, MAX_ROWS).map((cells, index) => {
      const row: Record<string, unknown> = { _row: sheet.headerLine + index + 1 }
      for (const field of def.fields) {
        const column = mapping[field.key]
        if (column === undefined || column < 0) continue
        const value = cells[column]
        row[field.key] = field.type === 'date' ? toDate(value, dayFirst) : field.type === 'time' ? toTime(value) : value instanceof Date ? toDate(value, dayFirst) : value
      }
      if (typeof row.date === 'string' && row.time && /^\d{4}-\d{2}-\d{2}/.test(row.date)) row.date = `${row.date.slice(0, 10)} ${row.time}`
      delete row.time
      return row
    })
  }, [sheet, mapping, def, dayFirst])

  const missing = def.fields.filter((f) => f.required && f.key !== 'name' && f.key !== 'price' && mapping[f.key] === undefined)
  const needsProduct = ['sales', 'waste'].includes(kind) && !['barcode', 'sku', 'name'].some((key) => mapping[key] !== undefined)
  const canSend = rows.length > 0 && !missing.length && !needsProduct && busy === null && isOwner

  async function send(dryRun: boolean) {
    setBusy(dryRun ? 'checking' : 'importing')
    setError(null)
    try {
      const result = await postImport(kind, rows, dryRun)
      if (dryRun) setChecked(result)
      else {
        setImported(result)
        setChecked(null)
        actions.toast(`Imported ${result.inserted + result.updated} ${def.unit} from ${fileName}`)
        void actions.refreshLive()
      }
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  function template() {
    const example: Record<ImportKind, (string | number)[]> = {
      products: ['4800016644290', 'SKU-0101', 'Datu Puti Vinegar 1L', 'Condiments', 'Pinoy Condiments Dist.', 'bottle', 62, 46, 40, 10, 5, '2027-03-31', 'yes'],
      employees: ['Juan Dela Cruz', '', '', 'juan@example.com', '09170000000', 'Active'],
      sales: ['OR-004512', '2026-08-14', '09:15', '4800016644290', 'SKU-0101', 'Datu Puti Vinegar 1L', 2, 62, 124, 'Cash', 'Regular', 'Maria Santos', '', '', 200, ''],
      waste: ['2026-08-14', '4800016644290', 'SKU-0101', 'Datu Puti Vinegar 1L', 1, 'Damaged', 'Dropped at aisle 3'],
      requests: ['Oat milk 1L', '2026-08-14', 'Dairy', 'Walk-in customer', '09170000000', 2, 'New', ''],
    }
    downloadCsv(`${kind}-import-template.csv`, def.fields.map((f) => f.label), [example[kind]])
  }

  const result = imported ?? checked
  const preview = rows.slice(0, 8)
  const mappedFields = def.fields.filter((f) => mapping[f.key] !== undefined && f.key !== 'time')

  return <div className="module-panel data-import">
    <div className="module-intro">
      <div><span className="eyebrow">MOVE FROM THE OLD SYSTEM</span><h2>Import data</h2><p>Export each list from the old system as Excel or CSV, then bring it in here. Import products first: sales and waste are matched to products by barcode, SKU or name.</p></div>
      <div className="intro-actions"><button className="outline-button" onClick={template}>↓ {def.label.toUpperCase()} TEMPLATE</button></div>
    </div>

    {state.source !== 'live' && <div className="advisory-banner"><span>!</span><p><b>Not connected to the store database</b><small>Imports go to the server PC's database. Start the app on the server PC (or check the connection) and try again.</small></p></div>}
    {!isOwner && <div className="advisory-banner"><span>!</span><p><b>Owner only</b><small>Only the owner can import data.</small></p></div>}

    <section className="import-step">
      <span className="import-step-number">1</span>
      <div>
        <b>What are you importing?</b>
        <Segmented label="Import type" options={KINDS.map((k) => k.label)} value={def.label} onChange={(label) => chooseKind(KINDS.find((k) => k.label === label)!.kind)} />
        <p className="muted-text">{def.label}: {def.summary}</p>
      </div>
    </section>

    <section className="import-step">
      <span className="import-step-number">2</span>
      <div>
        <b>Choose the file</b>
        <label className="file-drop">
          <input type="file" accept=".csv,.xlsx,.xls,.ods,.txt" onChange={(e) => void onFile(e)} disabled={busy !== null} />
          <span>{busy === 'reading' ? 'Reading…' : fileName ? `${fileName} · ${num(sheet?.rows.length ?? 0)} rows — choose another file` : 'Choose a .xlsx, .xls or .csv file'}</span>
        </label>
        {sheets.length > 1 && <Field label="SHEET"><Select value={sheet?.name} onChange={(e) => chooseSheet(e.target.value)}>{sheets.map((s) => <option key={s.name}>{s.name}</option>)}</Select></Field>}
        {(sheet?.rows.length ?? 0) > MAX_ROWS && <p className="pin-error">Only the first {num(MAX_ROWS)} rows will be imported. Split the file and import the rest separately.</p>}
      </div>
    </section>

    {sheet && <section className="import-step">
      <span className="import-step-number">3</span>
      <div>
        <b>Match the columns</b>
        <p className="muted-text">Matched automatically from the column names. Check each one; leave a field on “not in file” if the old system doesn't have it.</p>
        <div className="import-mapping">
          {def.fields.map((field) => <Field key={field.key} label={`${field.label.toUpperCase()}${field.required ? ' *' : ''}`} hint={field.hint}>
            <Select value={mapping[field.key] ?? -1} onChange={(e) => { resetResults(); setMapping((m) => { const next = { ...m }; if (Number(e.target.value) < 0) delete next[field.key]; else next[field.key] = Number(e.target.value); return next }) }}>
              <option value={-1}>— not in file —</option>
              {sheet.headers.map((header, i) => <option key={i} value={i}>{header}</option>)}
            </Select>
          </Field>)}
        </div>
        {def.fields.some((f) => f.type === 'date') && <label className="toggle-row import-toggle"><div><b>Dates are day first (DD/MM/YYYY)</b><small>Off: 08/14/2026 is August 14. Dates like 2026-08-14 work either way.</small></div><input type="checkbox" checked={dayFirst} onChange={(e) => { resetResults(); setDayFirst(e.target.checked) }} /></label>}
        {(missing.length > 0 || needsProduct) && <p className="pin-error">Match {[...missing.map((f) => f.label), ...(needsProduct ? ['a barcode, SKU or product name column'] : [])].join(', ')} to continue.</p>}

        {mappedFields.length > 0 && <div className="data-table-wrap import-preview"><table className="data-table">
          <thead><tr><th>LINE</th>{mappedFields.map((f) => <th key={f.key}>{f.label.toUpperCase()}</th>)}</tr></thead>
          <tbody>{preview.map((row) => <tr key={String(row._row)}><td>{String(row._row)}</td>{mappedFields.map((f) => <td key={f.key}>{row[f.key] === null || row[f.key] === undefined ? <span className="muted-text">—</span> : String(row[f.key])}</td>)}</tr>)}</tbody>
        </table></div>}
        {rows.length > preview.length && <p className="muted-text">Showing {preview.length} of {num(rows.length)} rows.</p>}
      </div>
    </section>}

    {sheet && <section className="import-step">
      <span className="import-step-number">4</span>
      <div>
        <b>Check, then import</b>
        <p className="muted-text">Checking runs the whole import without saving anything, so you can fix the file first.</p>
        <div className="import-actions">
          <button className="outline-button" disabled={!canSend} onClick={() => void send(true)}>{busy === 'checking' ? 'CHECKING…' : 'CHECK FILE'}</button>
          <button className="primary-button" disabled={!canSend || !checked} title={checked ? undefined : 'Check the file first'} onClick={() => void send(false)}>
            {busy === 'importing' ? 'IMPORTING…' : checked ? `IMPORT ${num(checked.inserted + checked.updated)} ${def.unit.toUpperCase()}${checked.errors.length ? ` · SKIP ${checked.errors.length} WITH ERRORS` : ''}` : 'IMPORT'}
          </button>
        </div>
        {error && <p className="pin-error" role="alert">{error}</p>}

        {result && <div className="import-result">
          <span className="eyebrow">{result.dry_run ? 'CHECK RESULT · NOTHING SAVED YET' : 'IMPORTED'}</span>
          <div className="import-counts">
            <div><strong>{num(result.inserted)}</strong><small>{result.dry_run ? 'will be added' : 'added'}</small></div>
            <div><strong>{num(result.updated)}</strong><small>{result.dry_run ? 'will be updated' : 'updated'}</small></div>
            <div><strong>{num(result.skipped)}</strong><small>already there</small></div>
            <div className={result.errors.length ? 'has-errors' : ''}><strong>{num(result.errors.length)}</strong><small>with errors</small></div>
          </div>
          {result.notes.map((note) => <p key={note} className="muted-text">• {note}</p>)}
          {result.errors.length > 0 && <div className="data-table-wrap"><table className="data-table">
            <thead><tr><th>LINE</th><th>PROBLEM</th></tr></thead>
            <tbody>{result.errors.slice(0, 200).map((e, i) => <tr key={i}><td>{e.row || '—'}</td><td>{e.message}</td></tr>)}</tbody>
          </table>{result.errors.length > 200 && <p className="muted-text pad">…and {result.errors.length - 200} more.</p>}</div>}
          {!result.dry_run && result.errors.length > 0 && <p className="muted-text">Fix the lines above in the file and import it again: rows already imported are skipped or updated, not duplicated.</p>}
        </div>}
      </div>
    </section>}

    {!sheet && !busy && <Empty>Choose a file to see its columns.</Empty>}
  </div>
}
