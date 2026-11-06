import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// One calendar for every date in the app. Values are YYYY-MM-DD strings (what the server and the old
// <input type="date"> use); people see and read them as mm/dd/yyyy.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const pad = (n: number) => String(n).padStart(2, '0')
const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromKey = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d) }
const isKey = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
/** 2026-10-20 → 10/20/2026 */
const formatDate = (key: string) => (isKey(key) ? `${key.slice(5, 7)}/${key.slice(8, 10)}/${key.slice(0, 4)}` : '')

const CalendarIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>

/** One month grid. `from`/`to` shade the chosen day or range; `preview` stretches the range to the day under the pointer. */
function Calendar({ from, to, min, max, onPick, preview, onHover }: {
  from: string; to: string; min?: string; max?: string
  onPick: (key: string) => void
  preview?: string
  onHover?: (key: string) => void
}) {
  const anchor = isKey(from) ? fromKey(from) : isKey(to) ? fromKey(to) : new Date()
  const [view, setView] = useState({ year: anchor.getFullYear(), month: anchor.getMonth() })
  const shift = (months: number) => setView((v) => { const d = new Date(v.year, v.month + months, 1); return { year: d.getFullYear(), month: d.getMonth() } })
  const first = new Date(view.year, view.month, 1)
  const days = new Date(view.year, view.month + 1, 0).getDate()
  const cells: (string | null)[] = [...Array(first.getDay()).fill(null), ...Array.from({ length: days }, (_, i) => toKey(new Date(view.year, view.month, i + 1)))]
  const today = toKey(new Date())
  const end = to || preview || ''
  const [lo, hi] = isKey(from) && isKey(end) && end < from ? [end, from] : [from, end]

  return <div className="datepicker-calendar">
    <div className="datepicker-nav">
      <button type="button" aria-label="Previous year" onClick={() => shift(-12)}>«</button>
      <button type="button" aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
      <b>{MONTHS[view.month]} {view.year}</b>
      <button type="button" aria-label="Next month" onClick={() => shift(1)}>›</button>
      <button type="button" aria-label="Next year" onClick={() => shift(12)}>»</button>
    </div>
    <div className="datepicker-grid" role="grid">
      {WEEKDAYS.map((d) => <span key={d} className="datepicker-weekday">{d}</span>)}
      {cells.map((key, i) => {
        if (!key) return <span key={`blank-${i}`} />
        const disabled = Boolean((min && key < min) || (max && key > max))
        const edge = key === lo || key === hi
        const inside = isKey(lo) && isKey(hi) && key > lo && key < hi
        return <button type="button" key={key} disabled={disabled} aria-pressed={edge}
          className={`datepicker-day${edge ? ' selected' : ''}${inside ? ' in-range' : ''}${key === today ? ' today' : ''}`}
          onClick={() => onPick(key)} onMouseEnter={() => onHover?.(key)}>{Number(key.slice(8))}</button>
      })}
    </div>
  </div>
}

/** The field that opens the calendar. It sits under the field and flips above it when there is no room below. */
function PickerShell({ display, placeholder, ariaLabel, disabled, onClear, clearable, children, onOpenChange }: {
  display: string; placeholder: string; ariaLabel: string; disabled?: boolean
  clearable?: boolean; onClear?: () => void
  children: (close: () => void) => ReactNode
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const height = popover.current?.offsetHeight ?? 290
    const width = popover.current?.offsetWidth ?? 252
    const top = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4
    setPos({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!popover.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    const close = () => setOpen(false)
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', key, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  useEffect(() => { onOpenChange?.(open) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return <span className="datepicker">
    <button type="button" ref={button} className={`datepicker-field${display ? '' : ' empty'}`} disabled={disabled} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen((v) => !v)}>
      <span>{display || placeholder}</span><CalendarIcon />
    </button>
    {clearable && display && !disabled && <button type="button" className="datepicker-clear" aria-label={`Clear ${ariaLabel.toLowerCase()}`} onClick={onClear}>×</button>}
    {open && createPortal(
      <div ref={popover} className="datepicker-popover" role="dialog" aria-label={ariaLabel} style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}>
        {children(() => setOpen(false))}
      </div>, document.body)}
  </span>
}

/** A single date, shown as mm/dd/yyyy. */
export function DatePicker({ value, onChange, min, max, ariaLabel = 'Date', placeholder = 'mm/dd/yyyy', clearable }: {
  value: string; onChange: (value: string) => void; min?: string; max?: string
  ariaLabel?: string; placeholder?: string; clearable?: boolean
}) {
  return <PickerShell display={formatDate(value)} placeholder={placeholder} ariaLabel={ariaLabel} clearable={clearable} onClear={() => onChange('')}>
    {(close) => <Calendar from={value} to="" min={min} max={max} onPick={(key) => { onChange(key); close() }} />}
  </PickerShell>
}

/** Two dates in one field: click the first day, then the last. Shown as "mm/dd/yyyy – mm/dd/yyyy". */
export function DateRangePicker({ from, to, onChange, max, ariaLabel = 'Date range' }: {
  from: string; to: string; onChange: (from: string, to: string) => void; max?: string; ariaLabel?: string
}) {
  const [draft, setDraft] = useState<string | null>(null) // first click made, waiting for the second
  const [hover, setHover] = useState('')
  const display = isKey(from) && isKey(to) ? `${formatDate(from)} – ${formatDate(to)}` : isKey(from) ? `${formatDate(from)} – …` : isKey(to) ? `… – ${formatDate(to)}` : ''

  function pick(key: string, close: () => void) {
    if (draft === null) { setDraft(key); setHover(key); return }
    const [a, b] = key < draft ? [key, draft] : [draft, key]
    onChange(a, b)
    setDraft(null)
    close()
  }

  return <PickerShell display={display} placeholder="mm/dd/yyyy – mm/dd/yyyy" ariaLabel={ariaLabel} onOpenChange={(open) => { if (!open) setDraft(null) }}>
    {(close) => <>
      <Calendar from={draft ?? from} to={draft === null ? to : ''} max={max} onPick={(key) => pick(key, close)} preview={draft === null ? undefined : hover} onHover={draft === null ? undefined : setHover} />
      <p className="datepicker-hint">{draft === null ? 'Pick the first day' : 'Now pick the last day'}</p>
    </>}
  </PickerShell>
}
