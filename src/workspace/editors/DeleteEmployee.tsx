import { useState } from 'react'
import type { Employee } from '../../data/types'
import { api, apiErrorMessage } from '../../services/api'
import { useStore } from '../../store/StoreContext'
import { Modal } from '../ui'

/** DELETE button for one row of the Employees panel, with its confirmation window. Owner accounts get no button. */
export function DeleteEmployeeButton({ employee, onDeleted }: { employee: Employee; onDeleted: () => void }) {
  const { state, actions } = useStore()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (employee.role === 'Owner' || state.source !== 'live') return null

  async function remove() {
    setBusy(true); setError(null)
    try {
      await api.delete(`/api/employees/${employee.id}`)
      actions.toast(`${employee.name} deleted`)
      setOpen(false)
      onDeleted()
      void actions.refreshLive()
    } catch (e) { setError(apiErrorMessage(e)) } finally { setBusy(false) }
  }

  return <>
    <button className="outline-button" onClick={() => { setError(null); setOpen(true) }}>DELETE</button>
    {open && <Modal title={`Delete ${employee.name}?`} eyebrow="PERMANENT" onClose={() => setOpen(false)} footer={<>
      <button className="outline-button" onClick={() => setOpen(false)}>CANCEL</button>
      <button className="danger-button" disabled={busy} onClick={() => void remove()}>{busy ? 'DELETING…' : 'DELETE FOR GOOD'}</button></>}>
      <p>This removes {employee.name} from the system and cannot be undone. It only works for someone with no sales, refunds, stock or waste records. If they have any, use <b>Deactivate</b> instead, which keeps their history.</p>
      {error && <p className="form-error">{error}</p>}
    </Modal>}
  </>
}