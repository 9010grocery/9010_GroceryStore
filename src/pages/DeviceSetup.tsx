import { useEffect, useState } from 'react'
import { iconRegistry } from '../icons/iconRegistry'
import { Field, Segmented } from '../workspace/ui'
import { Select } from '../workspace/Select'

type Role = 'Server PC' | 'Cashier terminal'
type TerminalChoice = { terminal_id: string; terminal_name: string | null }

const TERMINAL_ID = /^PC-\d{2}$/

/**
 * First-launch setup on each PC: is this the server (Express + MySQL + ML) or a cashier terminal?
 * Saved by Electron in the app's settings file; the app restarts to apply it.
 */
function DeviceSetup() {
  const [role, setRole] = useState<Role>('Cashier terminal')
  const [terminalId, setTerminalId] = useState('PC-01')
  const [serverHost, setServerHost] = useState('')
  const [apiPort, setApiPort] = useState('4010')
  const [db, setDb] = useState({ host: '127.0.0.1', port: '3306', user: 'pos_app', password: '', name: 'grocery9010' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Terminals the owner has added in Admin Station, fetched from the server once its address is typed in.
  const [choices, setChoices] = useState<{ host: string; list: TerminalChoice[] } | { host: string; error: string } | null>(null)

  const isServer = role === 'Server PC'
  const validHost = /^[A-Za-z0-9.-]+$/.test(serverHost.trim())
  const valid = isServer ? Boolean(db.user && db.name) : validHost && TERMINAL_ID.test(terminalId)
  const address = `${serverHost.trim()}:${apiPort}`
  const list = choices && choices.host === address && 'list' in choices ? choices.list : null
  const lookupError = choices && choices.host === address && 'error' in choices ? choices.error : null

  useEffect(() => {
    if (isServer || !validHost || !apiPort) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`http://${address}/api/terminal`, { signal: controller.signal })
        if (!response.ok) throw new Error(`Server answered ${response.status}`)
        const found = (await response.json()) as TerminalChoice[]
        setChoices({ host: address, list: found })
        if (found.length && !found.some((t) => t.terminal_id === terminalId)) setTerminalId(found[0].terminal_id)
      } catch (err) {
        if (!controller.signal.aborted) setChoices({ host: address, error: err instanceof Error ? err.message : String(err) })
      }
    }, 500)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [isServer, validHost, address, apiPort])

  async function save() {
    if (!window.desktop || !valid) return
    setSaving(true)
    setError(null)
    try {
      await window.desktop.saveConfig(
        isServer
          ? { mode: 'server', terminalId: null, apiPort: Number(apiPort), database: { ...db, port: Number(db.port) } }
          : { mode: 'terminal', terminalId, serverHost: serverHost.trim(), apiPort: Number(apiPort) },
      )
      await window.desktop.relaunch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return <main className="login-screen">
    <section className="login-brand">
      <div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span>{iconRegistry.brandMark}</span></div><div><strong>9010</strong><span>GROCERY SYSTEM</span></div></div>
      <div className="login-hero"><span className="eyebrow">FIRST-TIME SETUP</span><h1>Set up this PC</h1><p>One server PC runs the store database. Each cashier PC connects to it over the LAN.</p></div>
      <ul className="login-features">
        <li><b>Server PC</b><span>Runs the database, the API and the AI service. The owner's Admin Station.</span></li>
        <li><b>Cashier terminal</b><span>PC-01, PC-02, … as added by the owner in Admin Station. Unlocks when the owner assigns a cashier.</span></li>
      </ul>
    </section>
    <section className="login-panel setup-panel">
      <span className="eyebrow">THIS PC IS A…</span>
      <Segmented label="Role of this PC" options={['Cashier terminal', 'Server PC'] as const} value={role} onChange={setRole} />
      <div className="setup-form">
        {isServer ? <>
          <div className="form-row"><Field label="MYSQL HOST"><input value={db.host} onChange={(e) => setDb({ ...db, host: e.target.value })} /></Field><Field label="PORT"><input inputMode="numeric" value={db.port} onChange={(e) => setDb({ ...db, port: e.target.value.replace(/\D/g, '') })} /></Field></div>
          <div className="form-row"><Field label="MYSQL USER"><input value={db.user} onChange={(e) => setDb({ ...db, user: e.target.value })} /></Field><Field label="PASSWORD"><input type="password" value={db.password} onChange={(e) => setDb({ ...db, password: e.target.value })} /></Field></div>
          <div className="form-row"><Field label="DATABASE"><input value={db.name} onChange={(e) => setDb({ ...db, name: e.target.value })} /></Field><Field label="API PORT"><input inputMode="numeric" value={apiPort} onChange={(e) => setApiPort(e.target.value.replace(/\D/g, ''))} /></Field></div>
        </> : <>
          <div className="form-row"><Field label="SERVER PC ADDRESS" hint="LAN IP of the server PC, e.g. 192.168.1.10"><input value={serverHost} placeholder="192.168.1.10" onChange={(e) => setServerHost(e.target.value)} /></Field><Field label="API PORT"><input inputMode="numeric" value={apiPort} onChange={(e) => setApiPort(e.target.value.replace(/\D/g, ''))} /></Field></div>
          {list && list.length > 0
            ? <Field label="TERMINAL" hint="Missing one? Add it in Admin Station on the server PC, then retype the address."><Select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>{list.map((t) => <option key={t.terminal_id} value={t.terminal_id}>{t.terminal_id}{t.terminal_name ? ` · ${t.terminal_name}` : ''}</option>)}</Select></Field>
            : <Field label="TERMINAL" hint={list ? 'The server has no enabled terminals yet. Add this PC in Admin Station first.' : lookupError ? `Couldn't reach the server (${lookupError}). Type the ID the owner gave this PC.` : 'Enter the server address to list terminals, or type the ID (e.g. PC-04).'}><input value={terminalId} maxLength={5} aria-invalid={!TERMINAL_ID.test(terminalId)} onChange={(e) => setTerminalId(e.target.value.toUpperCase())} /></Field>}
        </>}
      </div>
      {error && <p className="pin-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={!valid || saving || !window.desktop} onClick={() => void save()}>{saving ? 'SAVING…' : 'SAVE AND RESTART'}</button>
    </section>
  </main>
}

export default DeviceSetup
