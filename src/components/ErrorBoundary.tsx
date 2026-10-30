import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * If something throws while the screen is drawing, React would unmount everything and leave a blank window.
 * This shows what went wrong instead, with a way to reload or to clear this PC's saved screen data.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed:', error, info.componentStack)
  }

  /** Forgets the layout, carts and cached data kept in this window. Store data on the server is not touched. */
  private clearAndReload = () => {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('pos9010')) localStorage.removeItem(key)
      sessionStorage.clear()
    } catch { /* nothing to clear */ }
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return <main className="app-splash" role="alert" style={{ gap: 12, padding: 24, textAlign: 'center' }}>
      <span className="eyebrow">SOMETHING WENT WRONG</span>
      <p>This screen could not be drawn.</p>
      <pre style={{ maxWidth: 'min(720px, 90vw)', maxHeight: 200, overflow: 'auto', margin: 0, padding: 12, textAlign: 'left', whiteSpace: 'pre-wrap', border: '1px solid #4a5047', background: '#242723', color: '#e6a39a', fontSize: 11 }}>{error.message}</pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="outline-button" onClick={() => window.location.reload()}>RELOAD</button>
        <button className="primary-button" onClick={this.clearAndReload}>CLEAR SAVED SCREEN DATA &amp; RELOAD</button>
      </div>
    </main>
  }
}
