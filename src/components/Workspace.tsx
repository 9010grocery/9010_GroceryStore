import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Navigate, useNavigate } from 'react-router-dom'
import type { WorkspaceName } from '../data/types'
import { iconRegistry } from '../icons/iconRegistry'
import { initials, time } from '../lib/format'
import { useAuth } from '../context/AuthContext'
import { useTerminal } from '../context/TerminalContext'
import { allowedWorkspaces, useAnalytics, useCurrentUser, useStore } from '../store/StoreContext'
import { editorGroups, editors, editorWorkspaces, type Editor } from '../workspace/editors'
import { Toasts } from '../workspace/ui'
import { MainMenu } from './MainMenu'
import { useOwnShift } from '../hooks/useOwnShift'

type Direction = 'horizontal' | 'vertical'
type LayoutNode =
  | { type: 'panel'; id: string; editor: Editor }
  | { type: 'split'; id: string; direction: Direction; ratio: number; first: LayoutNode; second: LayoutNode }

const makePanel = (editor: Editor): LayoutNode => ({ type: 'panel', id: crypto.randomUUID(), editor })
const makeSplit = (direction: Direction, first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode => ({
  type: 'split', id: crypto.randomUUID(), direction, ratio, first, second,
})

function defaultLayout(workspace: WorkspaceName): LayoutNode {
  switch (workspace) {
    case 'Admin Station': return makeSplit('horizontal', makePanel('Admin Station'), makePanel('Employees'), 0.5)
    case 'Point of Sale': return makeSplit('horizontal', makePanel('Product Grid'), makePanel('Cart'), 0.64)
    case 'Transactions': return makeSplit('horizontal', makePanel('Transactions'), makePanel('Returns & Refunds'), 0.6)
    // Overview strip across the top (30%), the stock table (60%) and purchasing (40%) below.
    case 'Inventory': return makeSplit('vertical', makePanel('Inventory Metrics'), makeSplit('horizontal', makePanel('Inventory Table'), makePanel('Purchasing'), 0.6), 0.3)
    case 'Purchasing': return makeSplit('horizontal', makePanel('Purchasing'), makePanel('Purchase Orders'), 0.58)
    case 'AI Insights': return makeSplit('horizontal', makeSplit('vertical', makePanel('Sales History'), makePanel('Trend Analysis'), 0.52), makeSplit('vertical', makePanel('AI Insights'), makePanel('Basket Analysis'), 0.55), 0.55)
    case 'Reports': return makePanel('Reports')
    case 'Write-offs': return makePanel('Write-off Log')
    case 'Requests': return makePanel('Customer Requests')
    case 'Settings': return makeSplit('horizontal', makePanel('Settings Navigation'), makePanel('Business Settings'), 0.3)
    default: return makePanel('Dashboard')
  }
}

function updateNode(node: LayoutNode, id: string, update: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (node.id === id) return update(node)
  if (node.type === 'panel') return node
  return { ...node, first: updateNode(node.first, id, update), second: updateNode(node.second, id, update) }
}

type SplitNode = Extract<LayoutNode, { type: 'split' }>

// On a phone-width screen a horizontal split is stacked, so it behaves like a vertical one.
const effectiveDirection = (direction: Direction): Direction => (window.matchMedia('(max-width: 540px)').matches && direction === 'horizontal' ? 'vertical' : direction)

/**
 * Re-fits the panels on one side of a dragged gutter. Only the panels that touch the gutter change size; panels
 * further away keep the size they had, so dragging one edge never resizes the whole neighbouring group.
 */
function resizeAlong(node: LayoutNode, axis: Direction, oldSize: number, newSize: number, edge: 'start' | 'end'): LayoutNode {
  if (node.type === 'panel') return node
  if (effectiveDirection(node.direction) !== axis) {
    // Children sit side by side across the axis, so each one touches the gutter and stretches with it.
    return { ...node, first: resizeAlong(node.first, axis, oldSize, newSize, edge), second: resizeAlong(node.second, axis, oldSize, newSize, edge) }
  }
  const minimum = 48
  if (newSize < minimum * 2) return node
  const firstOld = node.ratio * oldSize
  const secondOld = oldSize - firstOld
  if (edge === 'end') {
    const firstNew = Math.min(firstOld, newSize - minimum)
    return { ...node, ratio: firstNew / newSize, second: resizeAlong(node.second, axis, secondOld, newSize - firstNew, 'end') }
  }
  const secondNew = Math.min(secondOld, newSize - minimum)
  return { ...node, ratio: (newSize - secondNew) / newSize, first: resizeAlong(node.first, axis, firstOld, newSize - secondNew, 'start') }
}

/** Moves one gutter to `ratio` of its container (`size` px along the split's axis), resizing only the panels beside it. */
function moveGutter(split: SplitNode, ratio: number, size: number): LayoutNode {
  const axis = effectiveDirection(split.direction)
  const firstOld = split.ratio * size
  return {
    ...split,
    ratio,
    first: resizeAlong(split.first, axis, firstOld, ratio * size, 'end'),
    second: resizeAlong(split.second, axis, size - firstOld, size - ratio * size, 'start'),
  }
}

function replacePanel(node: LayoutNode, id: string, editor: Editor): LayoutNode {
  return updateNode(node, id, (item) => item.type === 'panel' ? { ...item, editor } : item)
}

function splitPanel(node: LayoutNode, id: string, direction: Direction, after: boolean, ratio = 0.5, editor?: Editor): LayoutNode {
  return updateNode(node, id, (item) => {
    if (item.type !== 'panel') return item
    const freshPanel = makePanel(editor ?? item.editor)
    return makeSplit(direction, after ? item : freshPanel, after ? freshPanel : item, ratio)
  })
}

function splitRatioAtPointer(direction: Direction, bounds: DOMRect, clientX: number, clientY: number) {
  const position = direction === 'horizontal' ? clientX - bounds.left : clientY - bounds.top
  const dimension = direction === 'horizontal' ? bounds.width : bounds.height
  return Math.max(0.005, Math.min(0.995, position / dimension))
}

function collapseSplit(node: LayoutNode, id: string, keep: 'first' | 'second'): LayoutNode {
  if (node.type === 'panel') return node
  if (node.id === id) return keep === 'first' ? node.first : node.second
  return { ...node, first: collapseSplit(node.first, id, keep), second: collapseSplit(node.second, id, keep) }
}

function editorForPanel(node: LayoutNode, id: string): Editor | undefined {
  if (node.type === 'panel') return node.id === id ? node.editor : undefined
  return editorForPanel(node.first, id) ?? editorForPanel(node.second, id)
}

type PanelNode = Extract<LayoutNode, { type: 'panel' }>
interface PanelRect { panel: PanelNode; x0: number; y0: number; x1: number; y1: number }

const edgeTolerance = 0.006

function collectPanelRects(node: LayoutNode, x0 = 0, y0 = 0, x1 = 1, y1 = 1, rects: PanelRect[] = []): PanelRect[] {
  if (node.type === 'panel') {
    rects.push({ panel: node, x0, y0, x1, y1 })
  } else if (node.direction === 'horizontal') {
    const cut = x0 + (x1 - x0) * node.ratio
    collectPanelRects(node.first, x0, y0, cut, y1, rects)
    collectPanelRects(node.second, cut, y0, x1, y1, rects)
  } else {
    const cut = y0 + (y1 - y0) * node.ratio
    collectPanelRects(node.first, x0, y0, x1, cut, rects)
    collectPanelRects(node.second, x0, cut, x1, y1, rects)
  }
  return rects
}

function buildLayoutFromRects(rects: PanelRect[], x0: number, y0: number, x1: number, y1: number): LayoutNode | undefined {
  if (rects.length === 1) return rects[0].panel
  for (const cut of new Set(rects.map((rect) => rect.x1).filter((x) => x < x1 - edgeTolerance))) {
    const first = rects.filter((rect) => rect.x1 <= cut + edgeTolerance)
    const second = rects.filter((rect) => rect.x0 >= cut - edgeTolerance)
    if (first.length === 0 || first.length + second.length !== rects.length) continue
    const firstNode = buildLayoutFromRects(first, x0, y0, cut, y1)
    const secondNode = buildLayoutFromRects(second, cut, y0, x1, y1)
    if (firstNode && secondNode) return makeSplit('horizontal', firstNode, secondNode, (cut - x0) / (x1 - x0))
  }
  for (const cut of new Set(rects.map((rect) => rect.y1).filter((y) => y < y1 - edgeTolerance))) {
    const first = rects.filter((rect) => rect.y1 <= cut + edgeTolerance)
    const second = rects.filter((rect) => rect.y0 >= cut - edgeTolerance)
    if (first.length === 0 || first.length + second.length !== rects.length) continue
    const firstNode = buildLayoutFromRects(first, x0, y0, x1, cut)
    const secondNode = buildLayoutFromRects(second, x0, cut, x1, y1)
    if (firstNode && secondNode) return makeSplit('vertical', firstNode, secondNode, (cut - y0) / (y1 - y0))
  }
  return undefined
}

// The target is absorbed only when the panels bordering it on the source's side
// start and end exactly where the target does (their gutters line up with its edges).
function joinPanels(layout: LayoutNode, sourceId: string, targetId: string): LayoutNode | undefined {
  const rects = collectPanelRects(layout)
  const source = rects.find((rect) => rect.panel.id === sourceId)
  const target = rects.find((rect) => rect.panel.id === targetId)
  if (!source || !target) return undefined
  const near = (a: number, b: number) => Math.abs(a - b) < edgeTolerance
  const overlapsY = (rect: PanelRect) => rect.y0 < target.y1 - edgeTolerance && rect.y1 > target.y0 + edgeTolerance
  const overlapsX = (rect: PanelRect) => rect.x0 < target.x1 - edgeTolerance && rect.x1 > target.x0 + edgeTolerance
  const sides = [
    { touches: (rect: PanelRect) => near(rect.x1, target.x0) && overlapsY(rect), vertical: true, grow: (rect: PanelRect) => ({ ...rect, x1: target.x1 }) },
    { touches: (rect: PanelRect) => near(rect.x0, target.x1) && overlapsY(rect), vertical: true, grow: (rect: PanelRect) => ({ ...rect, x0: target.x0 }) },
    { touches: (rect: PanelRect) => near(rect.y1, target.y0) && overlapsX(rect), vertical: false, grow: (rect: PanelRect) => ({ ...rect, y1: target.y1 }) },
    { touches: (rect: PanelRect) => near(rect.y0, target.y1) && overlapsX(rect), vertical: false, grow: (rect: PanelRect) => ({ ...rect, y0: target.y0 }) },
  ]
  const side = sides.find((candidate) => candidate.touches(source))
  if (!side) return undefined
  const neighbours = rects.filter((rect) => rect !== target && side.touches(rect))
  const aligned = side.vertical
    ? near(Math.min(...neighbours.map((rect) => rect.y0)), target.y0) && near(Math.max(...neighbours.map((rect) => rect.y1)), target.y1)
    : near(Math.min(...neighbours.map((rect) => rect.x0)), target.x0) && near(Math.max(...neighbours.map((rect) => rect.x1)), target.x1)
  if (!aligned) return undefined
  const remaining = rects.filter((rect) => rect !== target).map((rect) => neighbours.includes(rect) ? side.grow(rect) : rect)
  return buildLayoutFromRects(remaining, 0, 0, 1, 1)
}

function swapPanelEditors(node: LayoutNode, firstId: string, secondId: string): LayoutNode {
  const firstEditor = editorForPanel(node, firstId)
  const secondEditor = editorForPanel(node, secondId)
  if (!firstEditor || !secondEditor) return node
  return replacePanel(replacePanel(node, firstId, secondEditor), secondId, firstEditor)
}

function areasAreAdjacent(first: DOMRect, second: DOMRect) {
  const horizontalOverlap = first.top < second.bottom && first.bottom > second.top
  const verticalOverlap = first.left < second.right && first.right > second.left
  const touchesHorizontally = Math.abs(first.right - second.left) < 18 || Math.abs(second.right - first.left) < 18
  const touchesVertically = Math.abs(first.bottom - second.top) < 18 || Math.abs(second.bottom - first.top) < 18
  return (touchesHorizontally && horizontalOverlap) || (touchesVertically && verticalOverlap)
}


interface SplitDrag {
  panelId: string
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  ctrlKey: boolean
  gestureDirection?: Direction
  axisAnchorX: number
  axisAnchorY: number
  joinDirection?: 'left' | 'right' | 'up' | 'down'
  joinBlocked?: boolean
  targetId?: string
  ghost?: { left: number; top: number; width: number; height: number }
  targetRect?: { left: number; top: number; width: number; height: number }
  sourceCenter?: { left: number; top: number }
}

function classifySplitDirection(dx: number, dy: number): Direction | undefined {
  const horizontalTravel = Math.abs(dx)
  const verticalTravel = Math.abs(dy)
  const minimumTravel = 12
  const axisMargin = 1.2

  if (Math.max(horizontalTravel, verticalTravel) < minimumTravel) return undefined
  if (horizontalTravel >= verticalTravel * axisMargin) return 'horizontal'
  if (verticalTravel >= horizontalTravel * axisMargin) return 'vertical'
  return undefined
}

function resolveSplitDirection(dx: number, dy: number, previous?: Direction): Direction {
  return previous ?? classifySplitDirection(dx, dy) ?? (Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical')
}

function Workspace() {
  const { state } = useStore()
  const user = useCurrentUser()
  const auth = useAuth()
  // First sign-in as the default admin: only Settings (→ My account) until the owner has set up their account.
  const setupPending = Boolean(auth.user?.must_change_credentials)
  const allowed = user ? (setupPending ? ['Settings' as WorkspaceName] : allowedWorkspaces(state.settings, user.role)) : []
  // The owner starts on the Admin Station; a cashier starts on the first workspace they may open (Point of Sale).
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceName>(() => allowed[0] ?? 'Point of Sale')
  // Everyone lands on the main menu (a grid of workspaces), except the first-run account setup, which goes straight to Settings.
  const [home, setHome] = useState(!setupPending)
  const terminal = useTerminal()
  // Each workspace keeps its own arrangement while you switch tabs.
  const [layouts, setLayouts] = useState<Partial<Record<WorkspaceName, LayoutNode>>>({})
  // Built once per workspace: defaultLayout() makes fresh panel ids, and a split drag needs them to stay the same across renders.
  const defaultLayouts = useRef<Partial<Record<WorkspaceName, LayoutNode>>>({})
  const initialLayout = (workspace: WorkspaceName) => defaultLayouts.current[workspace] ??= defaultLayout(workspace)
  const layout = layouts[activeWorkspace] ?? initialLayout(activeWorkspace)
  const setLayout = (next: LayoutNode | ((current: LayoutNode) => LayoutNode)) => setLayouts((all) => {
    const current = all[activeWorkspace] ?? initialLayout(activeWorkspace)
    return { ...all, [activeWorkspace]: typeof next === 'function' ? next(current) : next }
  })
  const [dragging, setDragging] = useState(false)
  const [splitDrag, setSplitDrag] = useState<SplitDrag | null>(null)
  const allowedRef = useRef(allowed)

  useEffect(() => { allowedRef.current = allowed })

  // If role settings change while open, never leave the user on a workspace they can no longer open.
  const allowedKey = allowed.join('|')
  useEffect(() => {
    if (allowed.length && !allowed.includes(activeWorkspace)) setActiveWorkspace(allowed[0])
  }, [allowedKey, activeWorkspace])

  function selectWorkspace(workspace: WorkspaceName) {
    setActiveWorkspace(workspace)
    setHome(false)
    setSplitDrag(null)
  }

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const workspace = (event as CustomEvent<WorkspaceName>).detail
      if (allowedRef.current.includes(workspace)) selectWorkspace(workspace)
    }
    window.addEventListener('workspace-navigate', handleNavigate)
    return () => window.removeEventListener('workspace-navigate', handleNavigate)
  }, [])

  if (!user) return <Navigate to="/" replace />

  function beginSplitDrag(event: PointerEvent<HTMLButtonElement>, panelId: string) {
    event.preventDefault()
    event.stopPropagation()
    setSplitDrag({ panelId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, ctrlKey: event.ctrlKey, axisAnchorX: event.clientX, axisAnchorY: event.clientY })
  }

  function onWorkspacePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!splitDrag || splitDrag.pointerId !== event.pointerId) return
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-area-id]')
    const bounds = target?.getBoundingClientRect()
    const movementX = event.clientX - splitDrag.startX
    const movementY = event.clientY - splitDrag.startY
    let gestureDirection = splitDrag.gestureDirection
    let axisAnchorX = splitDrag.axisAnchorX
    let axisAnchorY = splitDrag.axisAnchorY
    if (!gestureDirection) {
      gestureDirection = classifySplitDirection(movementX, movementY)
      if (gestureDirection) {
        axisAnchorX = event.clientX
        axisAnchorY = event.clientY
      }
    } else {
      const sinceLockX = Math.abs(event.clientX - axisAnchorX)
      const sinceLockY = Math.abs(event.clientY - axisAnchorY)
      const perpendicularTravel = gestureDirection === 'horizontal' ? sinceLockY : sinceLockX
      if (perpendicularTravel >= 36) {
        gestureDirection = gestureDirection === 'horizontal' ? 'vertical' : 'horizontal'
        axisAnchorX = event.clientX
        axisAnchorY = event.clientY
      }
    }
    let ghost: SplitDrag['ghost']
    let joinDirection: SplitDrag['joinDirection']
    let sourceCenter: SplitDrag['sourceCenter']
    let targetPreviewRect: SplitDrag['targetRect']
    const ctrlKey = splitDrag.ctrlKey || event.ctrlKey
    const joinBlocked = !ctrlKey && !!target?.dataset.areaId && target.dataset.areaId !== splitDrag.panelId && !joinPanels(layout, splitDrag.panelId, target.dataset.areaId)
    if (target && bounds) {
      if (target.dataset.areaId === splitDrag.panelId && gestureDirection) {
        const ratio = splitRatioAtPointer(gestureDirection, bounds, event.clientX, event.clientY)
        ghost = gestureDirection === 'horizontal'
          ? { left: bounds.left + bounds.width * ratio, top: bounds.top, width: 2, height: bounds.height }
          : { left: bounds.left, top: bounds.top + bounds.height * ratio, width: bounds.width, height: 2 }
      } else if (target.dataset.areaId !== splitDrag.panelId) {
        const source = document.querySelector<HTMLElement>(`[data-area-id="${splitDrag.panelId}"]`)
        if (source) {
          const sourceBounds = source.getBoundingClientRect()
          const preview = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
          targetPreviewRect = preview
          const centerX = preview.left + preview.width / 2
          const centerY = preview.top + preview.height / 2
          const sourceX = sourceBounds.left + sourceBounds.width / 2
          const sourceY = sourceBounds.top + sourceBounds.height / 2
          const deltaX = centerX - sourceX
          const deltaY = centerY - sourceY
          sourceCenter = { left: sourceX, top: sourceY }
          joinDirection = Math.abs(deltaX) >= Math.abs(deltaY)
            ? deltaX < 0 ? 'left' : 'right'
            : deltaY < 0 ? 'up' : 'down'
        }
      }
    }
    setSplitDrag({
      ...splitDrag,
      x: event.clientX,
      y: event.clientY,
      ctrlKey,
      gestureDirection,
      axisAnchorX,
      axisAnchorY,
      joinDirection,
      joinBlocked,
      targetId: target?.dataset.areaId,
      ghost,
      targetRect: targetPreviewRect ?? (bounds ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : undefined),
      sourceCenter,
    })
  }

  function onWorkspacePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!splitDrag || splitDrag.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.clientX - splitDrag.startX, event.clientY - splitDrag.startY)
    if (distance > 12) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-area-id]')
      const targetId = target?.dataset.areaId
      if (targetId) {
        if (targetId !== splitDrag.panelId) {
          const source = document.querySelector<HTMLElement>(`[data-area-id="${splitDrag.panelId}"]`)
          const swapping = splitDrag.ctrlKey || event.ctrlKey
          if (swapping && source && areasAreAdjacent(source.getBoundingClientRect(), target.getBoundingClientRect())) {
            setLayout((current) => swapPanelEditors(current, splitDrag.panelId, targetId))
          } else if (!swapping) {
            const joined = joinPanels(layout, splitDrag.panelId, targetId)
            if (joined) setLayout(joined)
          }
        } else {
          const dx = event.clientX - splitDrag.startX
          const dy = event.clientY - splitDrag.startY
          const direction = resolveSplitDirection(dx, dy, splitDrag.gestureDirection)
          const after = true
          const ratio = splitRatioAtPointer(direction, target.getBoundingClientRect(), event.clientX, event.clientY)
          setLayout((current) => splitPanel(current, targetId, direction, after, ratio))
        }
      }
    }
    setSplitDrag(null)
  }

  return (
    <main className="workbench" data-workspace={activeWorkspace} onPointerMove={onWorkspacePointerMove} onPointerUp={onWorkspacePointerUp}>
      <nav className="workspace-tabs" aria-label="Workspaces">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span>{iconRegistry.brandMark}</span></div>
          <div><strong>9010</strong><span>GROCERY SYSTEM</span></div>
        </div>
        {home
          ? <span className="nav-crumb">HOME</span>
          : <button className="menu-home-button" onClick={() => { setHome(true); setSplitDrag(null) }} title="Back to the main menu">⌂ MAIN MENU</button>}
        <div className="workspace-tab-strip" />
        <AccountMenu />
      </nav>

      {home && <MainMenu workspaces={allowed} onOpen={selectWorkspace} />}
      {!home && <div className="workspace-titlebar">
        <div><span className="crumb">WORKSPACE</span><b>{activeWorkspace.toUpperCase()}</b><span className="crumb-separator">/</span><span className="title-detail">{workspaceDescription(activeWorkspace)}</span>{user.role === 'Cashier' && <span className="cashier-chip">Cashier: <b>{user.name}</b>{terminal.terminalId && <> · {terminal.terminalId}</>}{!terminal.online && <em> · reconnecting…</em>}</span>}</div>
        <div className="title-actions"><span className="sync-status"><i /> SAVED LOCALLY</span><button className="quiet-button" onClick={() => setLayout(defaultLayout(activeWorkspace))}>Reset layout</button></div>
      </div>}

      {!home && <section className={`area-canvas${dragging ? ' is-resizing' : ''}${splitDrag ? ' is-splitting' : ''}`}>
        <LayoutView
          node={layout}
          onLayoutChange={setLayout}
          onEditorChange={(id, editor) => setLayout((current) => replacePanel(current, id, editor))}
          onSplitDrag={beginSplitDrag}
          onResizeStart={() => setDragging(true)}
          onResizeEnd={() => setDragging(false)}
          splitDrag={splitDrag}
        />
        {splitDrag?.ghost && <div className="split-ghost" style={splitDrag.ghost} />}
        {splitDrag?.targetRect && splitDrag.targetId !== splitDrag.panelId && <div className={splitDrag.ctrlKey ? 'area-drop-overlay swap-preview' : splitDrag.joinBlocked ? 'area-drop-overlay join-blocked' : 'area-drop-overlay'} style={splitDrag.targetRect} aria-hidden="true" />}
        {splitDrag?.sourceCenter && splitDrag.joinDirection && <div className={splitDrag.ctrlKey ? 'join-direction-indicator swap-preview' : splitDrag.joinBlocked ? 'join-direction-indicator join-blocked' : 'join-direction-indicator'} style={splitDrag.sourceCenter} aria-hidden="true"><span>{splitDrag.ctrlKey ? '↔' : splitDrag.joinBlocked ? '⊘' : ({ left: '←', right: '→', up: '↑', down: '↓' })[splitDrag.joinDirection]}</span></div>}
      </section>}

      <StatusBar />
      <Toasts />
    </main>
  )
}

function AccountMenu() {
  const { state, actions } = useStore()
  const user = useCurrentUser()
  const auth = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const shift = useOwnShift()
  const cancelShiftPrompt = shift.cancel

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  // Closing the menu drops any half-answered shift prompt.
  useEffect(() => { if (!open) cancelShiftPrompt() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null
  const canSettings = allowedWorkspaces(state.settings, user.role).includes('Settings')
  const shiftOpen = !state.shift.closedAt

  return <div className="account-menu-wrap" ref={menuRef}>
    <button className="account-context" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
      <span className="account-clock">{shiftOpen ? 'SHIFT OPEN' : 'SHIFT CLOSED'} <b>{time(state.shift.openedAt)}</b></span><span className="avatar">{initials(user.name)}</span><span className="account-person">{user.name.split(' ')[0]} {user.name.split(' ')[1]?.[0] ?? ''}.<small>{user.role.toUpperCase()}</small></span><span className="account-caret">⌄</span>
    </button>
    {open && <div className="account-dropdown" role="menu" aria-label="Account menu">
      <div className="account-menu-profile"><span className="avatar">{initials(user.name)}</span><div><b>{user.name}</b><small>{user.role.toUpperCase()} · {user.role === 'Owner' ? 'FULL ACCESS' : `${allowedWorkspaces(state.settings, user.role).length} WORKSPACES`}</small></div></div>
      {canSettings && <button role="menuitem" onClick={() => { actions.navigate('Settings'); setOpen(false) }}><span>⚙</span> Store settings</button>}
      {user.role === 'Owner'
        ? <button role="menuitem" onClick={() => { setOpen(false); void auth.logout().then(() => navigate('/')) }}><span>⎋</span> Sign out</button>
        : shift.available
          ? shift.pending
            ? <div className="account-confirm" role="group" aria-label="Confirm">
              <b>{shift.pending === 'pause' ? 'Pause your shift?' : 'End your shift?'}</b>
              <p>{shift.pending === 'pause'
                ? 'A "shift paused" popup covers your screen. Your work stays as it is, and only the owner can resume it from the Admin Station.'
                : 'The terminal locks and your end time is recorded. The owner has to assign you again to start another shift.'}</p>
              <div>
                <button onClick={shift.cancel}>CANCEL</button>
                <button className={shift.pending === 'end' ? 'danger' : 'primary'} disabled={shift.busy} onClick={() => { setOpen(false); void shift.confirm() }}>{shift.pending === 'pause' ? 'PAUSE SHIFT' : 'END SHIFT'}</button>
              </div>
            </div>
            : <>
              <button role="menuitem" disabled={shift.busy} onClick={() => shift.ask('pause')}><span>⏸</span> Pause shift</button>
              <button role="menuitem" disabled={shift.busy} onClick={() => shift.ask('end')}><span>⎋</span> End shift</button>
            </>
          : <p className="account-menu-note">Your shift is ended by the owner from the Admin Station.</p>}
    </div>}
  </div>
}

function workspaceDescription(workspace: WorkspaceName) {
  const descriptions: Record<WorkspaceName, string> = {
    'Admin Station': 'Terminals, cashiers & team', Dashboard: 'Store overview', 'Point of Sale': 'Checkout terminal', Transactions: 'Receipts, returns & cash drawer', Inventory: 'Stock control', Purchasing: 'AI replenishment & suppliers',
    'AI Insights': 'Forecasts, trends & recommendations', Reports: 'BIR readings, tax & operations', 'Write-offs': 'Loss tracking', Requests: 'Customer demand', Settings: 'Store configuration',
  }
  return descriptions[workspace]
}

interface LayoutViewProps {
  node: LayoutNode
  onLayoutChange: (update: (current: LayoutNode) => LayoutNode) => void
  onEditorChange: (id: string, editor: Editor) => void
  onSplitDrag: (event: PointerEvent<HTMLButtonElement>, id: string) => void
  onResizeStart: () => void
  onResizeEnd: () => void
  splitDrag: SplitDrag | null
}

function LayoutView({ node, onLayoutChange, onEditorChange, onSplitDrag, onResizeStart, onResizeEnd, splitDrag }: LayoutViewProps) {
  if (node.type === 'panel') {
    const highlighted = splitDrag?.panelId === node.id && splitDrag.targetId === node.id && Math.hypot(splitDrag.x - splitDrag.startX, splitDrag.y - splitDrag.startY) > 12
    return (
      <article className={`workspace-area${highlighted ? ' split-target' : ''}`} data-area-id={node.id}>
        <AreaPanel node={node} onEditorChange={onEditorChange} onSplitDrag={onSplitDrag} />
      </article>
    )
  }

  const splitStyle = node.direction === 'horizontal'
    ? { gridTemplateColumns: `minmax(0, ${node.ratio}fr) 8px minmax(0, ${1 - node.ratio}fr)` }
    : { gridTemplateRows: `minmax(0, ${node.ratio}fr) 8px minmax(0, ${1 - node.ratio}fr)` }

  function onGutterPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (node.type !== 'split') return
    const splitNode = node
    const resizeDirection = effectiveDirection(splitNode.direction)
    const container = event.currentTarget.parentElement
    if (!container) return
    const bounds = container.getBoundingClientRect()
    const dimension = resizeDirection === 'horizontal' ? bounds.width : bounds.height
    const pointerId = event.pointerId
    event.currentTarget.setPointerCapture(pointerId)
    onResizeStart()

    const ratioAt = (e: globalThis.PointerEvent) => (resizeDirection === 'horizontal' ? e.clientX - bounds.left : e.clientY - bounds.top) / dimension
    // Every move starts from the split as it was when the drag began, so panels away from the gutter never drift.
    const apply = (ratio: number) => onLayoutChange((current) => updateNode(current, splitNode.id, () => moveGutter(splitNode, ratio, dimension)))

    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      apply(Math.max(0.04, Math.min(0.96, ratioAt(moveEvent))))
    }
    const end = (endEvent: globalThis.PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return
      const rawRatio = ratioAt(endEvent)
      if (rawRatio < 0.08) onLayoutChange((current) => collapseSplit(current, splitNode.id, 'second'))
      else if (rawRatio > 0.92) onLayoutChange((current) => collapseSplit(current, splitNode.id, 'first'))
      else apply(Math.max(0.12, Math.min(0.88, rawRatio)))
      onResizeEnd()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return (
    <div className={`area-split ${node.direction}`} style={splitStyle}>
      <LayoutView node={node.first} onLayoutChange={onLayoutChange} onEditorChange={onEditorChange} onSplitDrag={onSplitDrag} onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} splitDrag={splitDrag} />
      <div className={`area-gutter ${node.direction}`} role="separator" aria-orientation={node.direction === 'horizontal' ? 'vertical' : 'horizontal'} onPointerDown={onGutterPointerDown}>
        <span className="gutter-grip" />
      </div>
      <LayoutView node={node.second} onLayoutChange={onLayoutChange} onEditorChange={onEditorChange} onSplitDrag={onSplitDrag} onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} splitDrag={splitDrag} />
    </div>
  )
}

function AreaPanel({ node, onEditorChange, onSplitDrag }: {
  node: Extract<LayoutNode, { type: 'panel' }>
  onEditorChange: (id: string, editor: Editor) => void
  onSplitDrag: (event: PointerEvent<HTMLButtonElement>, id: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const { state } = useStore()
  const user = useCurrentUser()
  // A panel can only be switched to editors from workspaces this role may open (cashiers never see owner screens).
  const setupPending = Boolean(useAuth().user?.must_change_credentials)
  const allowed = user ? (setupPending ? ['Settings' as WorkspaceName] : allowedWorkspaces(state.settings, user.role)) : []
  const visibleGroups = editorGroups
    .map((group) => ({ ...group, items: group.items.filter((editor) => editorWorkspaces[editor].some((w) => allowed.includes(w))) }))
    .filter((group) => group.items.length > 0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setMenuOpen(false)
    }
    const closeOnViewportChange = () => setMenuOpen(false)
    // The menu is positioned once, so it closes when the page behind it scrolls, but scrolling its own list must not close it.
    const closeOnOutsideScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', closeOnViewportChange)
    window.addEventListener('scroll', closeOnOutsideScroll, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', closeOnViewportChange)
      window.removeEventListener('scroll', closeOnOutsideScroll, true)
    }
  }, [menuOpen])

  // Opened from the keyboard, the highlighted item gets focus so the arrow keys work straight away.
  useEffect(() => {
    if (!menuOpen || !menuPosition) return
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('.editor-menu-item')
    const current = menuRef.current?.querySelector<HTMLButtonElement>('.editor-menu-item.selected')
    ;(current ?? items?.[0])?.focus()
  }, [menuOpen, menuPosition])

  function onMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); triggerRef.current?.focus(); return }
    if (event.key === 'Tab') { setMenuOpen(false); return }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('.editor-menu-item') ?? [])]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const target = event.key === 'ArrowDown' ? items[(at + 1) % items.length]
      : event.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length]
      : event.key === 'Home' ? items[0]
      : event.key === 'End' ? items[items.length - 1]
      : null
    if (target) { event.preventDefault(); target.focus(); target.scrollIntoView({ block: 'nearest' }) }
  }

  function toggleMenu() {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    const bounds = triggerRef.current?.getBoundingClientRect()
    if (!bounds) return
    const menuWidth = Math.min(240, window.innerWidth - 16)
    const wanted = Math.min(window.innerHeight * 0.72, 560)
    const roomBelow = window.innerHeight - bounds.bottom - 13
    const roomAbove = bounds.top - 13
    const openAbove = roomBelow < Math.min(wanted, 340) && roomAbove > roomBelow
    // The list is never taller than the room it opens into, so its own scrollbar always reaches the last item.
    const maxHeight = Math.max(120, Math.min(wanted, openAbove ? roomAbove : roomBelow))
    const top = openAbove ? Math.max(8, bounds.top - maxHeight - 5) : bounds.bottom + 5
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - menuWidth - 8))
    setMenuPosition({ top, left, maxHeight })
    setMenuOpen(true)
  }

  return <>
    <header className="area-header">
      <div className="area-header-left">
        <div className="editor-menu-anchor">
          <button ref={triggerRef} className="editor-type-trigger" aria-haspopup="menu" aria-expanded={menuOpen} onClick={toggleMenu} onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(false); else if (event.key === 'ArrowDown' && !menuOpen) { event.preventDefault(); toggleMenu() } }}>
            <span className="editor-type-icon">{iconRegistry.editors[node.editor]}</span><span>{node.editor}</span><svg className="editor-type-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
          </button>
          {menuOpen && menuPosition && createPortal(<div ref={menuRef} className="editor-type-menu" style={menuPosition} role="menu" aria-label="Editor Type" onKeyDown={onMenuKey}>
            {visibleGroups.map((group) => <section className="editor-menu-group" key={group.category} role="group" aria-label={group.category}>
              <h3>{group.category}</h3>
              {group.items.map((editor) => <button key={editor} role="menuitemradio" aria-checked={node.editor === editor} className={node.editor === editor ? 'editor-menu-item selected' : 'editor-menu-item'} onClick={() => { onEditorChange(node.id, editor); setMenuOpen(false) }}>
                <span className="editor-type-icon">{iconRegistry.editors[editor]}</span><span>{editor}</span>{node.editor === editor && <i>✓</i>}
              </button>)}
            </section>)}
          </div>, document.body)}
        </div>
        <span className="area-path">{node.editor === 'Dashboard' ? 'OVERVIEW' : 'EDITOR'}</span>
      </div>
    </header>
    <button className="area-corner-handle" title="Drag corner to split, join, or Ctrl-drag to swap" aria-label="Drag area corner to split, join, or swap" onPointerDown={(event) => onSplitDrag(event, node.id)}><span>◢</span></button>
    <div className="area-content"><EditorContent editor={node.editor} /></div>
  </>
}

function EditorContent({ editor }: { editor: Editor }) {
  const Component = editors[editor]
  return <Component />
}

function StatusBar() {
  const { state } = useStore()
  const { insights } = useAnalytics()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const critical = insights.filter((i) => i.severity === 'critical').length
  return <footer className="status-bar">
    {state.source === 'live'
      ? <span title={state.liveError ?? (state.liveSyncedAt ? `Last loaded ${time(state.liveSyncedAt)}` : undefined)}><i className={state.liveError ? 'status-offline' : 'status-online'} /> {state.liveError ? 'SERVER UNREACHABLE · SHOWING LAST DATA' : 'LIVE · STORE DATABASE'}</span>
      : <span title="The store server hasn't been reached yet, so there is no data to show."><i className="status-demo" /> NOT CONNECTED</span>}
    <span>{state.transactions.length} RECEIPTS (7 DAYS)</span>
    {critical > 0 && <span className="status-alert">{critical} CRITICAL ALERT{critical > 1 ? 'S' : ''}</span>}
    <span className="status-right">{time(now)} <b>·</b> 9010 GROCERY <b>v1.1.0</b></span>
  </footer>
}

export default Workspace