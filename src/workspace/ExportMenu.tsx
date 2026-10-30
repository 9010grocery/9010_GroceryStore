import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { exportTable, type ExportFormat, type ExportTable } from '../lib/export'
import { useStore } from '../store/StoreContext'

const FORMATS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'csv', label: 'CSV', hint: 'Plain table, opens anywhere' },
  { format: 'xlsx', label: 'Excel', hint: '.xlsx workbook' },
  { format: 'pdf', label: 'PDF', hint: 'Printable document' },
]

/** One export button for every table: pick CSV, Excel or PDF. `build` runs when a format is chosen, so it exports what is on screen right then. */
export function ExportMenu({ build, label = '↓ EXPORT', className = 'outline-button', disabled }: {
  build: () => ExportTable
  label?: string
  className?: string
  disabled?: boolean
}) {
  const { actions } = useStore()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  // Opens under the button (right-aligned with it), or above when there is no room below.
  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const height = menu.current?.offsetHeight ?? 130
    const width = menu.current?.offsetWidth ?? 200
    const top = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4
    setPos({ top, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) })
  }, [open])

  // The highlighted item holds focus, so the arrow keys work as soon as the menu opens.
  useEffect(() => {
    if (!open) return
    menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[active]?.focus()
  }, [open, active, pos])

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    const close = () => setOpen(false)
    const scrolled = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', scrolled, true)
    }
  }, [open])

  async function run(format: ExportFormat) {
    setOpen(false)
    button.current?.focus()
    setBusy(true)
    try {
      const table = build()
      await exportTable(format, table)
      actions.toast(`${table.title} exported as ${format === 'xlsx' ? 'Excel' : format.toUpperCase()}`)
    } catch (error) {
      actions.toast(`Could not export: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus() }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((a) => (a + 1) % FORMATS.length) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((a) => (a - 1 + FORMATS.length) % FORMATS.length) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(FORMATS.length - 1) }
    else if (event.key === 'Tab') setOpen(false)
  }

  return <>
    <button type="button" ref={button} className={className} disabled={disabled || busy} aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setActive(0); setOpen((v) => !v) }}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setActive(0); setOpen(true) } }}>
      {busy ? 'EXPORTING…' : `${label} ▾`}
    </button>
    {open && createPortal(
      <div ref={menu} className="export-menu" role="menu" aria-label="Export as" onKeyDown={onMenuKey} style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}>
        {FORMATS.map((item, index) => <button key={item.format} type="button" role="menuitem" tabIndex={index === active ? 0 : -1} className="export-item" onMouseEnter={() => setActive(index)} onClick={() => void run(item.format)}>
          <b>{item.label}</b><small>{item.hint}</small>
        </button>)}
      </div>, document.body)}
  </>
}
