import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// The one dropdown for the whole app. A native <select> opens a list drawn by Windows, which can't be
// styled, so it never matched the rest of the screen. This keeps the <select>/<option> way of writing
// it, so a call site only changes its tag name: <Select value onChange={(e) => ...}><option>…</option></Select>.

interface Choice { value: string; label: string; disabled: boolean }

/** Reads the <option> elements (also inside fragments and .map()) into a plain list. */
function readChoices(children: ReactNode): Choice[] {
  const out: Choice[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    const element = child as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>
    if (element.type === Fragment) { out.push(...readChoices(element.props.children)); return }
    const label = Children.toArray(element.props.children).join('')
    out.push({ value: String(element.props.value ?? label), label, disabled: Boolean(element.props.disabled) })
  })
  return out
}

export function Select({ value, onChange, children, className, disabled, autoFocus, 'aria-label': ariaLabel }: {
  value: string | number | undefined
  onChange?: (event: { target: { value: string } }) => void
  children: ReactNode
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  'aria-label'?: string
}) {
  const choices = readChoices(children)
  const selected = choices.find((c) => c.value === String(value ?? ''))
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [box, setBox] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)

  function openList() {
    if (disabled) return
    setActive(Math.max(0, choices.findIndex((c) => c.value === selected?.value)))
    setOpen(true)
  }
  function choose(choice: Choice) {
    if (choice.disabled) return
    setOpen(false)
    button.current?.focus()
    if (choice.value !== selected?.value) onChange?.({ target: { value: choice.value } })
  }

  // Sits under the button, or above it when the screen is short; as wide as the button.
  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const wanted = Math.min(280, choices.length * 30 + 8)
    const flip = below < wanted && above > below
    const maxHeight = Math.max(100, Math.min(280, flip ? above : below))
    setBox({ top: flip ? Math.max(8, rect.top - Math.min(wanted, maxHeight) - 4) : rect.bottom + 4, left: rect.left, width: rect.width, maxHeight })
  }, [open, choices.length])

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    const close = () => setOpen(false)
    const scrolled = (event: Event) => { if (!list.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', scrolled, true)
    }
  }, [open])

  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, open, box])

  function step(from: number, direction: 1 | -1) {
    let next = from
    for (let i = 0; i < choices.length; i += 1) {
      next = (next + direction + choices.length) % choices.length
      if (!choices[next].disabled) return next
    }
    return from
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openList() }
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((a) => step(a, 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((a) => step(a, -1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(step(-1, 1)) }
    else if (event.key === 'End') { event.preventDefault(); setActive(step(choices.length, -1)) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (choices[active]) choose(choices[active]) }
    else if (event.key === 'Tab') setOpen(false)
    else if (event.key.length === 1) {
      const typed = event.key.toLowerCase()
      const hit = choices.findIndex((c, i) => i > active && !c.disabled && c.label.toLowerCase().startsWith(typed))
      const wrap = hit >= 0 ? hit : choices.findIndex((c) => !c.disabled && c.label.toLowerCase().startsWith(typed))
      if (wrap >= 0) setActive(wrap)
    }
  }

  return <>
    <button type="button" ref={button} className={`select-field${className ? ` ${className}` : ''}`} disabled={disabled} autoFocus={autoFocus} aria-label={ariaLabel}
      aria-haspopup="listbox" aria-expanded={open} onClick={() => (open ? setOpen(false) : openList())} onKeyDown={onKeyDown}>
      <span>{selected?.label ?? ''}</span>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
    </button>
    {open && createPortal(
      <div ref={list} className="select-list" role="listbox" aria-label={ariaLabel}
        style={box ? { top: box.top, left: box.left, minWidth: box.width, maxHeight: box.maxHeight } : { top: -9999, left: -9999 }}>
        {choices.map((choice, index) => <div key={choice.value} role="option" aria-selected={choice.value === selected?.value} aria-disabled={choice.disabled || undefined}
          data-active={index === active} className={`select-option${choice.value === selected?.value ? ' selected' : ''}${choice.disabled ? ' disabled' : ''}`}
          onMouseEnter={() => !choice.disabled && setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(choice)}>{choice.label}</div>)}
      </div>, document.body)}
  </>
}
