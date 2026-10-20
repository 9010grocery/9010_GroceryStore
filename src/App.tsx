import { useEffect, useState, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import MakeSale from './components/MakeSale'
import OwnerMainMenu from './components/OwnerMainMenu'
import ReceiptHistory from './components/ReceiptHistory'
import ReturnRefund from './components/ReturnRefund'
import Workspace from './components/Workspace'
import { AuthProvider, useAuth } from './context/AuthContext'
import { TerminalProvider, useTerminal } from './context/TerminalContext'
import DeviceSetup from './pages/DeviceSetup'
import OwnerLogin from './pages/OwnerLogin'
import TerminalLock from './pages/TerminalLock'
import WhoIsUsing from './pages/WhoIsUsing'
import { StoreProvider, useCurrentUser, useStore } from './store/StoreContext'

/** The person this screen is being used by, according to the server. */
function useSessionPerson() {
  const terminal = useTerminal()
  const auth = useAuth()
  if (terminal.mode === 'terminal') {
    // A paused shift keeps its person, so the screen they were on stays put behind the pause popup.
    const user = terminal.status?.assigned || terminal.status?.paused ? terminal.status.user : null
    return user ? { id: `u${user.user_id}`, name: user.name, role: 'Cashier' as const } : null
  }
  if (terminal.mode === 'server' && auth.status === 'signed_in' && auth.user) {
    return { id: `u${auth.user.user_id}`, name: auth.user.name, role: auth.user.role }
  }
  return null
}

/** Keeps the workspace's current user in step with the owner sign-in or the terminal assignment. */
function SessionBridge() {
  const person = useSessionPerson()
  const { actions } = useStore()
  const key = person ? `${person.id}|${person.name}|${person.role}` : ''
  useEffect(() => {
    if (person) actions.login(person)
    else actions.logout()
  }, [key, actions])
  return null
}

function Splash({ text }: { text: string }) {
  return <main className="app-splash"><span className="eyebrow">9010 GROCERY SYSTEM</span><p>{text}</p></main>
}

/** Covers the cashier's current screen, blurred, until the owner resumes the shift from the Admin Station. */
function ShiftPausedModal({ name, terminalId }: { name?: string; terminalId: string | null }) {
  return <div className="modal-backdrop pause-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="pause-title">
    <div className="modal pause-modal">
      <div className="lock-mark" aria-hidden="true"><span /></div>
      <h2 id="pause-title">Your shift has been paused</h2>
      <p>{name ? `${name}, take` : 'Take'} a short break. Everything on your screen is kept as you left it{terminalId ? ` on ${terminalId}` : ''}. This unlocks as soon as the owner resumes your shift.</p>
    </div>
  </div>
}

/** Decides what this PC shows: setup, owner sign-in, terminal lock screen, or the workspace. */
function Root() {
  const terminal = useTerminal()
  const auth = useAuth()
  const person = useSessionPerson()
  const current = useCurrentUser()
  const ready = person !== null && current?.id === person.id
  // Server PC: "I am the owner / a cashier" first; the owner then gets the PIN screen.
  const [ownerChosen, setOwnerChosen] = useState(false)

  if (terminal.mode === 'loading') return <Splash text="Starting…" />
  if (terminal.mode === 'unconfigured') return <DeviceSetup />

  if (terminal.mode === 'terminal') {
    const paused = Boolean(terminal.status?.paused)
    if (!terminal.status?.assigned && !paused) return <TerminalLock />
    if (!ready) return <Splash text="Unlocking…" />
    if (!paused) return <Workspace />
    return <>
      <div className="paused-behind" inert aria-hidden="true"><Workspace /></div>
      <ShiftPausedModal name={terminal.status?.user?.name} terminalId={terminal.terminalId} />
    </>
  }

  if (auth.status === 'checking') return <Splash text="Checking sign-in…" />
  if (auth.status !== 'signed_in') return ownerChosen ? <OwnerLogin onBack={() => setOwnerChosen(false)} /> : <WhoIsUsing onOwner={() => setOwnerChosen(true)} />
  return ready ? <Workspace /> : <Splash text="Opening Admin Station…" />
}

/** The older single-screen owner menu and its screens: owner only, never on a cashier terminal. */
function OwnerOnly({ children }: { children: ReactNode }) {
  const terminal = useTerminal()
  const auth = useAuth()
  if (terminal.mode === 'server' && auth.status === 'signed_in') return children
  return <Navigate to="/" replace />
}

function App() {
  return (
    <StoreProvider>
      <AuthProvider>
        <TerminalProvider>
          <SessionBridge />
          <HashRouter>
            <Routes>
              <Route path="/" element={<Root />} />
              <Route path="/workspace" element={<Navigate to="/" replace />} />
              <Route path="/owner" element={<OwnerOnly><OwnerMainMenu /></OwnerOnly>} />
              <Route path="/make-a-sale" element={<OwnerOnly><MakeSale /></OwnerOnly>} />
              <Route path="/return-refund" element={<OwnerOnly><ReturnRefund /></OwnerOnly>} />
              <Route path="/receipt-history" element={<OwnerOnly><ReceiptHistory /></OwnerOnly>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </HashRouter>
        </TerminalProvider>
      </AuthProvider>
    </StoreProvider>
  )
}

export default App
