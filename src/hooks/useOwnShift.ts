import { useState } from 'react'
import { useTerminal } from '../context/TerminalContext'
import { apiErrorMessage, endOwnShift, pauseOwnShift } from '../services/api'
import { useStore } from '../store/StoreContext'

/** What the cashier on a terminal can do to their own shift: lock the terminal for a while, or end the shift. */
export function useOwnShift() {
  const { mode, terminalId, status } = useTerminal()
  const { actions } = useStore()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<'pause' | 'end' | null>(null)
  const available = mode === 'terminal' && Boolean(terminalId) && Boolean(status?.assigned)

  async function run(work: (id: string) => Promise<void>, done: string) {
    if (!terminalId || busy) return
    setBusy(true)
    try {
      await work(terminalId)
      actions.toast(done)
    } catch (error) {
      actions.toast(apiErrorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return {
    available,
    busy,
    /** Which action is waiting for the cashier's confirmation (an in-app dialog; window.confirm freezes Electron windows). */
    pending,
    ask: (kind: 'pause' | 'end') => setPending(kind),
    cancel: () => setPending(null),
    confirm: async () => {
      const kind = pending
      setPending(null)
      if (kind === 'pause') await run(pauseOwnShift, 'Shift paused')
      if (kind === 'end') await run(endOwnShift, 'Shift ended')
    },
  }
}
