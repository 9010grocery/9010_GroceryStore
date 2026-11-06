import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/StoreContext'

// Validated categorical order for charts on the dark surface (see index.css --series-*).
export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)']

export function Metric({ label, value, change, note, accent, spark }: { label: string; value: string; change: string; note: string; accent: string; spark?: number[] }) {
  return <div className={`metric-card ${accent}`}>
    <div className="metric-top"><span>{label}</span><i>↗</i></div>
    <strong>{value}</strong>
    <div className="metric-note"><b>{change}</b><span>{note}</span></div>
    {spark ? <Sparkline values={spark} className="metric-sparkline" /> : <div className="metric-spark"><span /></div>}
  </div>
}

export function SectionHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <div className="section-heading"><h2>{title}</h2>{action && <button onClick={onAction}>{action} <span>↗</span></button>}</div>
}

export function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill ${value.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{value}</span>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>
}

export function Modal({ title, eyebrow, onClose, children, footer, wide }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(<div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><button className="modal-close" aria-label="Close" onClick={onClose}>✕</button></header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </div>
  </div>, document.body)
}

/** Asks "are you sure?" before anything is removed, cleared or discarded. Escape or CANCEL backs out. */
export function ConfirmModal({ title, message, confirmLabel, onConfirm, onCancel, danger = true }: {
  title: string; message: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean
}) {
  useEffect(() => {
    // Runs before any dialog underneath, so Escape closes only this one.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return createPortal(<div className="modal-backdrop confirm-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
    <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><div><h2>{title}</h2></div></header>
      <div className="modal-body">{message}</div>
      <footer className="modal-footer">
        <button className="outline-button" autoFocus onClick={onCancel}>CANCEL</button>
        <button className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm}>{confirmLabel}</button>
      </footer>
    </div>
  </div>, document.body)
}

/** The one search box: magnifier, the text, and an X to clear it once something is typed. */
export function SearchField({ value, onChange, placeholder, compact, autoFocus, inputRef, onKeyDown, ariaLabel }: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  compact?: boolean
  autoFocus?: boolean
  inputRef?: RefObject<HTMLInputElement | null>
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  ariaLabel?: string
}) {
  const own = useRef<HTMLInputElement>(null)
  const input = inputRef ?? own
  return <label className={compact ? 'search-field compact' : 'search-field'}>
    <span aria-hidden="true">⌕</span>
    <input ref={input} autoFocus={autoFocus} aria-label={ariaLabel ?? placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
    {value !== '' && <button type="button" className="search-clear" aria-label="Clear search" title="Clear" onClick={(event) => { event.preventDefault(); onChange(''); input.current?.focus() }}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
    </button>}
  </label>
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}

/** A 6-digit PIN box: dots by default, with an eye button to show the digits while typing. */
export function PinInput({ value, onChange, autoComplete = 'off', autoFocus, onEnter }: {
  value: string
  onChange: (pin: string) => void
  autoComplete?: string
  autoFocus?: boolean
  onEnter?: () => void
}) {
  const [shown, setShown] = useState(false)
  return <span className="pin-input">
    <input type={shown ? 'text' : 'password'} inputMode="numeric" autoComplete={autoComplete} autoFocus={autoFocus} maxLength={6} value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.() }} />
    <button type="button" className="pin-eye" aria-label={shown ? 'Hide PIN' : 'Show PIN'} aria-pressed={shown} title={shown ? 'Hide PIN' : 'Show PIN'}
      onMouseDown={(e) => e.preventDefault() /* keep the cursor in the PIN box */} onClick={(e) => { e.preventDefault(); setShown((s) => !s) }}>
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
        {shown && <path d="M4 4l16 16" />}
      </svg>
    </button>
  </span>
}

export function Toasts() {
  const { toasts } = useStore()
  return createPortal(<div className="toast-stack" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}><span>{t.tone === 'error' ? '!' : t.tone === 'info' ? 'i' : '✓'}</span>{t.message}</div>)}</div>, document.body)
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: readonly T[]; value: T; onChange: (value: T) => void; label?: string }) {
  return <div className="segmented" role="radiogroup" aria-label={label}>{options.map((option) => <button key={option} role="radio" aria-checked={value === option} className={value === option ? 'selected' : ''} onClick={() => onChange(option)}>{option}</button>)}</div>
}

// ---------- Charts ----------

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

const niceMax = (value: number) => {
  if (value <= 0) return 4
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude * 4 >= value) ?? 10
  return step * magnitude * 4
}

interface Tip { x: number; y: number; content: ReactNode }

function ChartTooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null
  return <div className="chart-tooltip" style={{ left: tip.x, top: tip.y }}>{tip.content}</div>
}

export interface Series { name: string; values: (number | null)[]; color: string; dashed?: boolean }

/**
 * Bars for actuals + lines for the remaining series, with an optional shaded
 * band (e.g. forecast confidence interval). One y-axis only.
 */
export function ComboChart({ labels, bars, lines = [], band, height = 220, format = (v: number) => v.toFixed(0), splitIndex }: {
  labels: string[]
  bars?: Series
  lines?: Series[]
  band?: { lower: (number | null)[]; upper: (number | null)[]; color: string; name: string }
  height?: number
  format?: (value: number) => string
  splitIndex?: number // index where the forecast region starts
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { top: 12, right: 12, bottom: 22, left: 40 }
  const innerW = Math.max(0, width - pad.left - pad.right)
  const innerH = height - pad.top - pad.bottom
  const all = [...(bars?.values ?? []), ...lines.flatMap((l) => l.values), ...(band?.upper ?? [])].filter((v): v is number => v !== null)
  const max = niceMax(Math.max(0, ...all))
  const n = labels.length
  const step = n ? innerW / n : 0
  const x = (i: number) => pad.left + step * i + step / 2
  const y = (v: number) => pad.top + innerH - (v / max) * innerH
  const barW = Math.max(2, Math.min(28, step * 0.56))
  const path = (values: (number | null)[]) => values.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).reduce<string[][]>((segments, point) => {
    if (point === null) segments.push([])
    else segments[segments.length - 1].push(point)
    return segments
  }, [[]]).filter((s) => s.length).map((s) => `M${s.join('L')}`).join(' ')
  const bandPath = band ? (() => {
    const idx = band.upper.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0)
    if (!idx.length) return ''
    return `M${idx.map((i) => `${x(i)},${y(band.upper[i]!)}`).join('L')}L${[...idx].reverse().map((i) => `${x(i)},${y(band.lower[i] ?? 0)}`).join('L')}Z`
  })() : ''
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 46))))

  const tip: Tip | null = hover === null ? null : {
    x: Math.min(Math.max(x(hover), 70), width - 70), y: pad.top,
    content: <><b>{labels[hover]}</b>
      {bars && bars.values[hover] !== null && <span><i style={{ background: bars.color }} />{bars.name}<em>{format(bars.values[hover]!)}</em></span>}
      {lines.map((l) => l.values[hover] !== null && <span key={l.name}><i style={{ background: l.color }} />{l.name}<em>{format(l.values[hover]!)}</em></span>)}
      {band && band.upper[hover] !== null && <span><i style={{ background: band.color, opacity: .4 }} />{band.name}<em>{format(band.lower[hover] ?? 0)}–{format(band.upper[hover]!)}</em></span>}
    </>,
  }

  return <div className="chart-box" ref={ref} style={{ height }} onPointerLeave={() => setHover(null)}>
    {width > 0 && <svg width={width} height={height} role="img" aria-label={[bars?.name, ...lines.map((l) => l.name)].filter(Boolean).join(', ')}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => <g key={t}><line className="chart-grid" x1={pad.left} x2={width - pad.right} y1={y(max * t)} y2={y(max * t)} /><text className="chart-axis" x={pad.left - 6} y={y(max * t) + 3} textAnchor="end">{format(max * t)}</text></g>)}
      {splitIndex !== undefined && splitIndex < n && <><rect className="forecast-zone" x={pad.left + step * splitIndex} y={pad.top} width={step * (n - splitIndex)} height={innerH} /><text className="chart-axis zone-label" x={pad.left + step * splitIndex + 5} y={pad.top + 10}>FORECAST</text></>}
      {band && <path d={bandPath} fill={band.color} opacity={0.18} />}
      {bars && bars.values.map((v, i) => v === null ? null : <rect key={i} x={x(i) - barW / 2} y={y(v)} width={barW} height={Math.max(0, pad.top + innerH - y(v))} rx={Math.min(3, barW / 2)} fill={bars.color} opacity={hover === null || hover === i ? 1 : 0.55} />)}
      {lines.map((l) => <g key={l.name}>
        <path d={path(l.values)} fill="none" stroke={l.color} strokeWidth={2} strokeDasharray={l.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
        {l.values.map((v, i) => v !== null && (hover === i || n <= 16) && <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4 : 2.5} fill={l.color} stroke="var(--area)" strokeWidth={1.5} />)}
      </g>)}
      {hover !== null && <line className="chart-crosshair" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} />}
      {labels.map((label, i) => i % labelEvery === 0 && <text key={i} className="chart-axis" x={x(i)} y={height - 6} textAnchor="middle">{label}</text>)}
      {labels.map((_, i) => <rect key={`hit${i}`} x={pad.left + step * i} y={pad.top} width={step} height={innerH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)} />)}
    </svg>}
    <ChartTooltip tip={tip} />
  </div>
}

export function Legend({ items }: { items: { name: string; color: string; kind?: 'bar' | 'line' | 'band' | 'dashed' }[] }) {
  return <div className="chart-legend-row">{items.map((item) => <span key={item.name}><i className={`legend-${item.kind ?? 'line'}`} style={{ background: item.kind === 'dashed' ? undefined : item.color, borderColor: item.color }} />{item.name}</span>)}</div>
}

export function Sparkline({ values, className, color = 'currentColor' }: { values: number[]; className?: string; color?: string }) {
  const max = Math.max(1, ...values)
  const min = Math.min(...values)
  const points = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${28 - ((v - min) / Math.max(1, max - min)) * 24}`).join(' ')
  return <svg className={className ?? 'sparkline'} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" /></svg>
}

export function BarList({ items, format, color = SERIES[0] }: { items: { label: string; value: number; note?: string }[]; format: (value: number) => string; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return <div className="bar-list">{items.map((item) => <div className="bar-list-row" key={item.label} title={`${item.label}: ${format(item.value)}`}>
    <div className="bar-list-label"><b>{item.label}</b>{item.note && <small>{item.note}</small>}</div>
    <div className="bar-list-track"><span style={{ width: `${(item.value / max) * 100}%`, background: color }} /></div>
    <strong>{format(item.value)}</strong>
  </div>)}</div>
}

export function Heatmap({ rows, rowLabels, colLabels, format }: { rows: number[][]; rowLabels: string[]; colLabels: string[]; format: (v: number, r: number, c: number) => string }) {
  const max = Math.max(1, ...rows.flat())
  const [tip, setTip] = useState<{ r: number; c: number } | null>(null)
  return <div className="heatmap" style={{ gridTemplateColumns: `34px repeat(${colLabels.length}, minmax(0, 1fr))` }} onPointerLeave={() => setTip(null)}>
    <span />
    {colLabels.map((label, i) => <span className="heatmap-col" key={i}>{label}</span>)}
    {rows.map((row, r) => <div className="heatmap-row" key={r} style={{ display: 'contents' }}>
      <span className="heatmap-row-label">{rowLabels[r]}</span>
      {row.map((value, c) => <span key={c} className={tip?.r === r && tip.c === c ? 'heatmap-cell active' : 'heatmap-cell'} style={{ ['--heat' as string]: value / max }} onPointerEnter={() => setTip({ r, c })} title={format(value, r, c)} />)}
    </div>)}
    {tip && <div className="heatmap-readout">{format(rows[tip.r][tip.c], tip.r, tip.c)}</div>}
  </div>
}
