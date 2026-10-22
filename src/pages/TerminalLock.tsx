import { useEffect, useState } from 'react'
import { useTerminal } from '../context/TerminalContext'
import { iconRegistry } from '../icons/iconRegistry'
import { setActingTerminal } from '../lib/actingTerminal'
import { time } from '../lib/format'
import { useStore } from '../store/StoreContext'

/** Cashier terminal, locked: shown until the owner assigns a cashier from the Admin Station. */
function TerminalLock() {
  const { state } = useStore()
  const { terminalId, status, online, error, acting } = useTerminal()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  const checking = !status && !error
  const paused = Boolean(status?.paused)

  return <main className="login-screen terminal-lock">
    <section className="login-brand">
      <div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span>{iconRegistry.brandMark}</span></div><div><strong>9010</strong><span>GROCERY SYSTEM</span></div></div>
      <div className="login-hero"><span className="eyebrow">{state.settings.storeName.toUpperCase()} · {status?.terminal_name?.toUpperCase() ?? 'CASHIER TERMINAL'}</span><h1>{terminalId ?? '—'}</h1><p>{time(now)} · {now.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
      <ul className="login-features">
        <li><b>No sign-in needed</b><span>The owner assigns a cashier to this terminal from the Admin Station</span></li>
        <li><b>Every sale is recorded</b><span>Sales on this terminal are attributed to the assigned cashier's session</span></li>
      </ul>
    </section>
    <section className="login-panel lock-panel" aria-live="polite">
      <div className={online ? 'lock-mark' : 'lock-mark offline'} aria-hidden="true"><span /></div>
      <h2 className="lock-title">{checking ? 'Connecting to the store server…' : paused ? 'Shift paused' : 'Waiting for owner assignment...'}</h2>
      <p className="pin-caption">{paused
        ? `${status?.user?.name ?? 'The cashier'}'s shift is paused and ${terminalId} is locked. The owner resumes it from the Admin Station.`
        : `This screen unlocks by itself when the owner assigns a cashier to ${terminalId}.`}</p>
      <div className={online ? 'lock-connection ok' : 'lock-connection'}>
        <i />
        {online ? 'Connected to the store server · checking every 2 seconds' : error ?? 'Connecting…'}
      </div>
      {/* Only on the server PC acting as a register; a real cashier PC can't leave its terminal. */}
      {acting && <button className="link-button lock-switch" onClick={() => setActingTerminal(null)}>← SWITCH TO OWNER SIGN-IN</button>}
    </section>
  </main>
}

export default TerminalLock
