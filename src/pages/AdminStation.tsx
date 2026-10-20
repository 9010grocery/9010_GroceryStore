import { useCallback, useEffect, useState } from 'react'
import { initials } from '../lib/format'
import {
  apiErrorMessage,
  assignTerminal,
  createTerminal,
  deleteTerminal,
  endShift,
  getAdminEmployees,
  getAdminTerminals,
  lockAllTerminals,
  pauseShift,
  resumeShift,
  updateTerminal,
  type EmployeeSummary,
  type SessionSummary,
  type TerminalSummary,
} from '../services/api'
import { useStore } from '../store/StoreContext'
import { DataImportPanel } from '../workspace/editors/DataImport'
import { Empty, Field, Modal } from '../workspace/ui'

const POLL_MS = 3000

/** Server DATETIME ("2026-10-06 08:00:12", store time) → "8:00 AM". */
function clock(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
}

function sinceText(value: string | null): string {
  if (!value) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value.replace(' ', 'T')).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return clock(value)
}

type Confirm =
  | { kind: 'end'; session: SessionSummary }
  | { kind: 'lock-all'; count: number }
  | { kind: 'delete-terminal'; terminal: TerminalSummary }

type TerminalForm = { mode: 'add' | 'edit'; terminal_id: string; terminal_name: string; is_active: boolean; onShift: boolean }

const TERMINAL_ID = /^PC-\d{2}$/

/**
 * Shows a register's screen next to the Admin Station: a separate Electron window acting as that terminal, or a new
 * browser tab with ?terminal=. Assign a cashier here and watch it unlock there.
 */
function openTerminalView(terminalId: string) {
  if (window.desktop?.openTerminalWindow) void window.desktop.openTerminalWindow(terminalId)
  else window.open(`${window.location.origin}${window.location.pathname}?terminal=${terminalId}`, '_blank', 'noopener')
}

/** The lowest unused PC-NN, so adding a fourth PC suggests PC-04. */
function nextTerminalId(terminals: TerminalSummary[]): string {
  const used = new Set(terminals.map((t) => t.terminal_id))
  for (let n = 1; n < 100; n++) {
    const id = `PC-${String(n).padStart(2, '0')}`
    if (!used.has(id)) return id
  }
  return ''
}

/**
 * Admin Station — the owner's main screen. Assigns cashiers to terminals and ends shifts (employees themselves are managed in the Employees panel).
 * Registered as a workspace editor, so it lives inside the normal split-panel workspace.
 */
export function AdminStationPanel() {
  const { actions } = useStore()
  const [terminals, setTerminals] = useState<TerminalSummary[]>([])
  const [employees, setEmployees] = useState<EmployeeSummary[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [form, setForm] = useState<TerminalForm | null>(null)
  const [importing, setImporting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [t, e] = await Promise.all([getAdminTerminals(), getAdminEmployees()])
      setTerminals(t)
      setEmployees(e)
      setLoadError(null)
    } catch (error) {
      setLoadError(apiErrorMessage(error))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const loop = async () => {
      await refresh()
      if (!stopped) timer = window.setTimeout(loop, POLL_MS)
    }
    void loop()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [refresh])

  async function run(key: string, work: () => Promise<string>) {
    setBusy(key)
    try {
      actions.toast(await work())
      await refresh()
    } catch (error) {
      actions.toast(apiErrorMessage(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const assign = (userId: number, terminalId: string, name: string) =>
    run(`assign-${userId}-${terminalId}`, async () => {
      await assignTerminal(userId, terminalId)
      setChoice({})
      return `${name} assigned to ${terminalId}`
    })

  function saveTerminal(current: TerminalForm) {
    const id = current.terminal_id.trim().toUpperCase()
    const name = current.terminal_name.trim()
    void run(`terminal-${id}`, async () => {
      if (current.mode === 'add') {
        await createTerminal(id, name)
        setForm(null)
        return `${id} added. On that PC, choose "Cashier terminal" and ${id} during setup.`
      }
      await updateTerminal(id, { terminal_name: name, is_active: current.is_active })
      setForm(null)
      return `${id} saved`
    })
  }

  const sessions = terminals.flatMap((t) => (t.session ? [t.session] : []))
  const cashiers = employees.filter((e) => e.role === 'Cashier')
  const available = cashiers.filter((e) => e.is_active && !e.assigned_terminal)

  return <div className="module-panel admin-station">
    <div className="module-intro">
      <div><span className="eyebrow">OWNER CONTROL</span><h2>Admin Station</h2><p>Assign a cashier to a terminal and it unlocks within seconds. Cashiers need no PIN; every sale is tied to their session.</p></div>
      <div className="intro-actions">
        <button className="outline-button" onClick={() => setImporting(true)}>⇪ IMPORT DATA</button>
        <button className="outline-button" disabled={busy !== null || !loaded || Boolean(loadError)} onClick={() => setForm({ mode: 'add', terminal_id: nextTerminalId(terminals), terminal_name: '', is_active: true, onShift: false })}>＋ ADD TERMINAL</button>
        <button className="danger-button" disabled={sessions.length === 0 || busy !== null} onClick={() => setConfirm({ kind: 'lock-all', count: sessions.length })}>LOCK ALL TERMINALS</button>
      </div>
    </div>

    {loadError && <div className="advisory-banner"><span>!</span><p><b>Cannot load terminals</b><small>{loadError}</small></p></div>}

    <div className="terminal-grid">
      {!loaded && <Empty>Loading terminals…</Empty>}
      {loaded && !loadError && terminals.length === 0 && <Empty>No terminals yet. Use “Add terminal” for each cashier PC.</Empty>}
      {terminals.map((terminal) => {
        const session = terminal.session
        const pick = choice[terminal.terminal_id] ?? ''
        return <section key={terminal.terminal_id} className={`terminal-card${session ? ' assigned' : ''}${terminal.is_active ? '' : ' disabled'}`}>
          <header>
            <div><b>{terminal.terminal_id}</b><small>{terminal.terminal_name ?? 'Cashier terminal'}</small></div>
            <span className={terminal.online ? 'terminal-online on' : 'terminal-online'}><i />{terminal.online ? 'ONLINE' : 'OFFLINE'}</span>
          </header>
          {session ? <>
            <div className="terminal-cashier"><span className="avatar">{initials(session.cashier_name)}</span><div><small>CASHIER</small><b>{session.cashier_name}</b></div></div>
            <p className="terminal-meta">{session.is_paused ? `Paused since ${clock(session.paused_at)} · terminal locked` : `Since ${clock(session.assigned_at)} · ${session.login_time ? `unlocked ${clock(session.login_time)}` : 'waiting for terminal to unlock'}`}</p>
            <div className="terminal-shift-actions">
              {session.is_paused
                ? <button className="primary-button" disabled={busy !== null} onClick={() => void run(`resume-${session.session_id}`, async () => { await resumeShift(session.session_id); return `${session.terminal_id} resumed · ${session.cashier_name} is back on shift` })}>RESUME SHIFT</button>
                : <button className="outline-button" disabled={busy !== null} onClick={() => void run(`pause-${session.session_id}`, async () => { await pauseShift(session.session_id); return `${session.terminal_id} locked · ${session.cashier_name}'s shift paused` })}>PAUSE SHIFT</button>}
              <button className="outline-button" disabled={busy !== null} onClick={() => setConfirm({ kind: 'end', session })}>END SHIFT</button>
            </div>
          </> : <>
            <p className="terminal-locked">{terminal.is_active ? 'Locked · waiting for assignment' : 'Terminal disabled'}</p>
            <div className="terminal-assign">
              <select className="select" aria-label={`Cashier for ${terminal.terminal_id}`} value={pick} disabled={!terminal.is_active || available.length === 0} onChange={(e) => setChoice({ ...choice, [terminal.terminal_id]: e.target.value })}>
                <option value="">{available.length ? 'Choose cashier…' : 'No free cashiers'}</option>
                {available.map((e) => <option key={e.user_id} value={e.user_id}>{e.name}</option>)}
              </select>
              <button className="primary-button" disabled={!pick || busy !== null} onClick={() => { const e = available.find((x) => String(x.user_id) === pick); if (e) void assign(e.user_id, terminal.terminal_id, e.name) }}>ASSIGN</button>
            </div>
          </>}
          <footer className="terminal-footer">
            <p className="terminal-seen">{terminal.ip_address ?? 'Not registered yet'} · seen {sinceText(terminal.last_seen)}</p>
            {terminal.is_active && <button className="link-button" title={`See what ${terminal.terminal_id} shows, in a separate window`} onClick={() => openTerminalView(terminal.terminal_id)}>OPEN WINDOW ↗</button>}
            <button className="link-button" disabled={busy !== null} onClick={() => setForm({ mode: 'edit', terminal_id: terminal.terminal_id, terminal_name: terminal.terminal_name ?? '', is_active: terminal.is_active, onShift: Boolean(session) })}>EDIT</button>
          </footer>
        </section>
      })}
    </div>

    {/* Employees are listed and edited in the Employees panel beside this one; cashiers are assigned on the cards above. */}
    {loaded && cashiers.length === 0 && <Empty>No cashiers yet. Add employees in the Employees panel beside this one.</Empty>}

    {confirm?.kind === 'end' && <Modal title={`End ${confirm.session.cashier_name}'s shift?`} eyebrow={confirm.session.terminal_id} onClose={() => setConfirm(null)} footer={<>
      <button className="outline-button" onClick={() => setConfirm(null)}>KEEP</button>
      <button className="danger-button" disabled={busy !== null} onClick={() => { const s = confirm.session; setConfirm(null); void run(`end-${s.session_id}`, async () => { await endShift(s.session_id); return `${s.terminal_id} locked · ${s.cashier_name}'s shift ended` }) }}>END SHIFT</button>
    </>}>
      <p className="muted-text">{confirm.session.terminal_id} locks and shows “Waiting for owner assignment…”. The end time is recorded in the Employees table, and sales already made stay recorded under this session. To lock it only for a while, use Pause shift instead.</p>
    </Modal>}

    {confirm?.kind === 'lock-all' && <Modal title="Lock all terminals?" eyebrow="END ALL SHIFTS" onClose={() => setConfirm(null)} footer={<>
      <button className="outline-button" onClick={() => setConfirm(null)}>CANCEL</button>
      <button className="danger-button" disabled={busy !== null} onClick={() => { setConfirm(null); void run('lock-all', async () => { const r = await lockAllTerminals(); return `${r.ended_count} shift${r.ended_count === 1 ? '' : 's'} ended · all terminals locked` }) }}>LOCK ALL</button>
    </>}>
      <p className="muted-text">Ends {confirm.count} active shift{confirm.count === 1 ? '' : 's'}. Every terminal returns to “Waiting for owner assignment…”.</p>
    </Modal>}

    {importing && <Modal wide title="Import from the old system" eyebrow="DATA IMPORT" onClose={() => setImporting(false)} footer={<button className="outline-button" onClick={() => setImporting(false)}>CLOSE</button>}>
      <DataImportPanel />
    </Modal>}

    {form && <TerminalFormModal
      form={form}
      terminals={terminals}
      busy={busy}
      onChange={setForm}
      onClose={() => setForm(null)}
      onSave={saveTerminal}
      onDelete={() => { const t = terminals.find((x) => x.terminal_id === form.terminal_id); setForm(null); if (t) setConfirm({ kind: 'delete-terminal', terminal: t }) }}
    />}

    {confirm?.kind === 'delete-terminal' && <Modal title={`Delete ${confirm.terminal.terminal_id}?`} eyebrow="CASHIER PC" onClose={() => setConfirm(null)} footer={<>
      <button className="outline-button" onClick={() => setConfirm(null)}>CANCEL</button>
      <button className="danger-button" disabled={busy !== null} onClick={() => { const t = confirm.terminal; setConfirm(null); void run(`delete-${t.terminal_id}`, async () => { await deleteTerminal(t.terminal_id); return `${t.terminal_id} deleted` }) }}>DELETE</button>
    </>}>
      <p className="muted-text">Only for a terminal added by mistake. A terminal that has ever had a shift or a sale is kept for the records; disable it instead.</p>
    </Modal>}
  </div>
}

function TerminalFormModal({ form, terminals, busy, onChange, onClose, onSave, onDelete }: {
  form: TerminalForm
  terminals: TerminalSummary[]
  busy: string | null
  onChange: (form: TerminalForm) => void
  onClose: () => void
  onSave: (form: TerminalForm) => void
  onDelete: () => void
}) {
  const adding = form.mode === 'add'
  const id = form.terminal_id.trim().toUpperCase()
  const idError = !adding || !id ? null
    : !TERMINAL_ID.test(id) ? 'Use PC- followed by two digits, e.g. PC-04'
    : terminals.some((t) => t.terminal_id === id) ? `${id} already exists`
    : null
  const canSave = Boolean(id) && !idError && busy === null

  return <Modal title={adding ? 'Add terminal' : `Edit ${form.terminal_id}`} eyebrow="CASHIER PC" onClose={onClose} footer={<>
    {!adding && <button className="link-button danger-link" disabled={busy !== null || form.onShift} title={form.onShift ? 'End the shift first' : undefined} onClick={onDelete}>DELETE</button>}
    <button className="outline-button" onClick={onClose}>CANCEL</button>
    <button className="primary-button" disabled={!canSave} onClick={() => onSave(form)}>{adding ? 'ADD TERMINAL' : 'SAVE'}</button>
  </>}>
    <form className="terminal-form" onSubmit={(e) => { e.preventDefault(); if (canSave) onSave(form) }}>
      {adding
        ? <Field label="TERMINAL ID" hint={idError ?? 'Choose this same ID on that PC when it is set up as a cashier terminal.'}><input value={form.terminal_id} maxLength={5} autoFocus aria-invalid={Boolean(idError)} onChange={(e) => onChange({ ...form, terminal_id: e.target.value.toUpperCase() })} /></Field>
        : <Field label="TERMINAL ID" hint="The ID can't be changed: shifts and sales are recorded under it."><input value={form.terminal_id} disabled /></Field>}
      <Field label="NAME" hint="Optional, e.g. Counter 4 or Express lane."><input value={form.terminal_name} maxLength={50} placeholder="Cashier terminal" onChange={(e) => onChange({ ...form, terminal_name: e.target.value })} /></Field>
      {!adding && <label className="toggle-row">
        <div><b>Enabled</b><small>{form.onShift ? 'A cashier is on shift here. End the shift before disabling.' : "A disabled terminal stays locked and can't be assigned. Its history is kept."}</small></div>
        <input type="checkbox" checked={form.is_active} disabled={form.onShift && form.is_active} onChange={(e) => onChange({ ...form, is_active: e.target.checked })} />
      </label>}
      <button type="submit" hidden />
    </form>
  </Modal>
}

export default AdminStationPanel
