import { useEffect, useRef } from 'react'

/** A scanner "types" its barcode far faster than a person can; keystrokes further apart than this start a new code. */
const MAX_GAP_MS = 70
/** Shortest code treated as a scan, so a stray Enter after one or two keys isn't taken for one. */
const MIN_LENGTH = 4

const isEditable = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'))
}

/**
 * Barcode scanners that work as a keyboard ("keyboard wedge") send the digits and then Enter. When the cashier isn't typing
 * in a field (focus is on a product tile, the cart, or nothing), this catches that burst and calls `onScan` with the code.
 * While a field has focus the keystrokes go into it as usual (the POS search box handles Enter itself), and while a
 * dialog is open nothing is captured.
 */
export function useScannerWedge(onScan: (code: string) => void, enabled = true) {
  const latest = useRef(onScan)
  useEffect(() => {
    latest.current = onScan
  }, [onScan])

  useEffect(() => {
    if (!enabled) return
    let buffer = ''
    let last = 0
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (isEditable(event.target) || document.querySelector('.modal-backdrop')) {
        buffer = ''
        return
      }
      if (event.key === 'Enter') {
        const code = buffer
        buffer = ''
        if (code.length >= MIN_LENGTH) {
          event.preventDefault()
          latest.current(code)
        }
        return
      }
      if (event.key.length !== 1) return
      const now = performance.now()
      if (buffer && now - last > MAX_GAP_MS) buffer = ''
      buffer += event.key
      last = now
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
