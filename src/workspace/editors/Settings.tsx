import { useState } from 'react'
import { allWorkspaces, OWNER_ONLY_WORKSPACES } from '../../data/defaults'
import type { PaymentMethod, Role, Settings } from '../../data/types'
import { useCurrentUser, useStore, type SettingsSection } from '../../store/StoreContext'
import { useAuth } from '../../context/AuthContext'
import { Field } from '../ui'
import { MyAccount } from './MyAccount'
import { Select } from '../Select'

const sections: SettingsSection[] = ['My account', 'Business profile', 'Tax & receipts', 'Payment methods', 'Inventory & AI', 'Notifications', 'Access & roles', 'Data', 'Testing']

export function SettingsNav() {
  const { state, actions } = useStore()
  // First sign-in as the default admin: My account has to be done before anything else.
  const setupPending = Boolean(useAuth().user?.must_change_credentials)
  return <div className="settings-nav"><span className="eyebrow">CONFIGURATION</span><h2>Store settings</h2>
    {sections.map((section) => <button className={(setupPending ? section === 'My account' : state.ui.settingsSection === section) ? 'selected' : ''} key={section} disabled={setupPending && section !== 'My account'} title={setupPending && section !== 'My account' ? 'Set up your account first' : undefined} onClick={() => actions.setUi({ settingsSection: section })}>{section}<span>›</span></button>)}
  </div>
}

export function SettingsPanel() {
  const { state, actions } = useStore()
  const user = useCurrentUser()
  const [draft, setDraft] = useState<Settings>(state.settings)
  const setupPending = Boolean(useAuth().user?.must_change_credentials)
  const section = setupPending ? 'My account' : state.ui.settingsSection
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings)
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const readOnly = user?.role !== 'Owner'

  const save = () => { actions.updateSettings(draft); actions.toast('Settings saved') }

  return <div className="settings-form">
    <span className="eyebrow">{section.toUpperCase()}</span>
    {section === 'My account' && <MyAccount />}
    {section === 'Business profile' && <>
      <h2>Store information</h2><p>These details appear on receipts and generated reports.</p>
      <Field label="REGISTERED BUSINESS NAME"><input value={draft.businessName} onChange={(e) => set('businessName', e.target.value)} /></Field>
      <Field label="STORE DISPLAY NAME"><input value={draft.storeName} onChange={(e) => set('storeName', e.target.value)} /></Field>
      <div className="form-row"><Field label="BUSINESS TIN"><input value={draft.tin} onChange={(e) => set('tin', e.target.value)} /></Field><Field label="STORE CODE"><input value={draft.storeCode} onChange={(e) => set('storeCode', e.target.value)} /></Field></div>
      <Field label="REGISTERED ADDRESS"><textarea value={draft.address} onChange={(e) => set('address', e.target.value)} /></Field>
    </>}
    {section === 'Tax & receipts' && <>
      <h2>Tax &amp; receipts</h2><p>Shelf prices are VAT-inclusive. Senior citizen and PWD sales are VAT-exempt with a 20% discount.</p>
      <div className="form-row"><Field label="VAT RATE (%)"><input type="number" min={0} max={25} value={Math.round(draft.vatRate * 100)} onChange={(e) => set('vatRate', Number(e.target.value) / 100)} /></Field><Field label="MACHINE SERIAL (MIN)"><input value={draft.machineSerial} onChange={(e) => set('machineSerial', e.target.value)} /></Field></div>
      <Field label="PERMIT TO USE (PTU) NO."><input value={draft.permitNumber} onChange={(e) => set('permitNumber', e.target.value)} /></Field>
      <Field label="RECEIPT HEADER MESSAGE"><input value={draft.receiptHeader} onChange={(e) => set('receiptHeader', e.target.value)} /></Field>
      <Field label="RECEIPT FOOTER"><textarea value={draft.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} /></Field>
    </>}
    {section === 'Payment methods' && <>
      <h2>Payment methods</h2><p>Choose which tenders appear at checkout.</p>
      <div className="toggle-list">{(Object.keys(draft.payments) as PaymentMethod[]).map((m) => <label className="toggle-row" key={m}><div><b>{m}</b><small>{m === 'Cash' ? 'Calculates change automatically' : m === 'Card' ? 'Approval code required' : 'Reference number required'}</small></div><input type="checkbox" checked={draft.payments[m]} disabled={m === 'Cash'} onChange={(e) => set('payments', { ...draft.payments, [m]: e.target.checked })} /></label>)}</div>
    </>}
    {section === 'Inventory & AI' && <>
      <h2>Inventory</h2><p>Controls how recent sales turn into reorder suggestions and expiry alerts.</p>
      <div className="form-row">
        <Field label="SERVICE LEVEL" hint="Higher = more safety stock, fewer stock-outs"><Select value={draft.serviceLevel} onChange={(e) => set('serviceLevel', Number(e.target.value))}>{[0.8, 0.9, 0.95, 0.975, 0.99].map((v) => <option key={v} value={v}>{(v * 100).toFixed(1).replace('.0', '')}%</option>)}</Select></Field>
        <Field label="TARGET DAYS OF COVER" hint="Stock to hold after the lead time"><input type="number" min={1} max={60} value={draft.coverDays} onChange={(e) => set('coverDays', Number(e.target.value))} /></Field>
      </div>
      <div className="form-row">
        <Field label="EXPIRY WARNING (DAYS)"><input type="number" min={1} max={60} value={draft.expiryWarningDays} onChange={(e) => set('expiryWarningDays', Number(e.target.value))} /></Field>
      </div>
    </>}
    {section === 'Testing' && <>
      <h2>Testing tools</h2><p>For trying the app before barcode scanners are set up. These stay on this PC and should be off in the store.</p>
      <div className="toggle-list"><label className="toggle-row"><div><b>Simulate barcode scan</b><small>Shows a ▥ button in the Point of Sale search bar that adds a random product to the cart, as a real scan would.</small></div><input type="checkbox" checked={draft.simulateBarcodeScan} disabled={readOnly} onChange={(e) => set('simulateBarcodeScan', e.target.checked)} /></label></div>
    </>}
    {section === 'Notifications' && <>
      <h2>Notifications</h2><p>Choose which alerts appear on the dashboard and in the AI insights feed.</p>
      <div className="toggle-list">{([['lowStock', 'Low-stock & stock-out predictions'], ['expiry', 'Near-expiry stock'], ['requests', 'New customer requests'], ['aiDigest', 'Daily AI digest at opening'], ['shiftReminder', 'Cash count reminders']] as [keyof Settings['notifications'], string][]).map(([key, label]) => <label className="toggle-row" key={key}><div><b>{label}</b></div><input type="checkbox" checked={draft.notifications[key]} onChange={(e) => set('notifications', { ...draft.notifications, [key]: e.target.checked })} /></label>)}</div>
    </>}
    {section === 'Access & roles' && <>
      <h2>Access &amp; roles</h2><p>Which workspaces each role can open. The owner always has full access; Admin Station (which includes Employees) and Settings are owner-only.</p>
      <div className="data-table-wrap"><table className="data-table permission-table"><thead><tr><th>WORKSPACE</th>{(['Owner', 'Cashier'] as Role[]).map((r) => <th key={r}>{r.toUpperCase()}</th>)}</tr></thead><tbody>
        {allWorkspaces.map((w) => <tr key={w}><td><b>{w}</b></td>{(['Owner', 'Cashier'] as Role[]).map((r) => r !== 'Owner' && OWNER_ONLY_WORKSPACES.includes(w) ? <td key={r} title="Owner only">—</td> : <td key={r}><input type="checkbox" aria-label={`${r} can open ${w}`} disabled={r === 'Owner'} checked={draft.rolePermissions[r].includes(w)} onChange={(e) => set('rolePermissions', { ...draft.rolePermissions, [r]: e.target.checked ? allWorkspaces.filter((x) => x === w || draft.rolePermissions[r].includes(x)) : draft.rolePermissions[r].filter((x) => x !== w) })} /></td>)}</tr>)}
      </tbody></table></div>
    </>}
    {section === 'Data' && state.source === 'live' && <>
      <h2>Store data</h2><p>Products, stock, sales, refunds, write-offs, customer requests and employees are read from and saved to the store database on the server PC. To bring in records from the old system, open the Data Import panel in Admin Station.</p>
      <button className="outline-button" onClick={() => actions.navigate('Admin Station')}>OPEN ADMIN STATION →</button>
    </>}
    {section === 'Data' && state.source === 'demo' && <>
      <h2>Not connected</h2><p>This PC hasn't reached the store server yet, so there is no data to show. Start the app on the server PC (or check the network); the screens fill in as soon as it connects.</p>
    </>}
    {section !== 'Data' && section !== 'My account' && <div className="form-actions"><span>{readOnly ? 'VIEW ONLY · OWNER ACCESS REQUIRED' : dirty ? 'UNSAVED CHANGES' : 'ALL CHANGES SAVED'}</span><div>{dirty && <button className="outline-button" onClick={() => setDraft(state.settings)}>DISCARD</button>}<button className="primary-button" disabled={!dirty || readOnly} onClick={save}>SAVE CHANGES</button></div></div>}
  </div>
}