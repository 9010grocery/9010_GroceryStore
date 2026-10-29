import { useCallback, useEffect, useState } from 'react'
import { apiErrorMessage } from '../services/api'

/**
 * Loads data from the server (live mode only) and reloads whenever `deps` change or `reload()` is called.
 * In demo mode (`enabled` false) nothing is fetched and `data` stays null, so the screen can compute locally.
 */
export function useServerData<T>(enabled: boolean, load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [result, setResult] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: enabled })
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setResult((r) => ({ ...r, loading: true }))
    load().then(
      (data) => { if (!cancelled) setResult({ data, error: null, loading: false }) },
      (error) => { if (!cancelled) setResult((r) => ({ data: r.data, error: apiErrorMessage(error), loading: false })) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, version, ...deps])
  return enabled ? { ...result, reload } : { data: null, error: null, loading: false, reload }
}