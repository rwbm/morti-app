import type { CompiledPanel, PanelOperation, PanelRole } from './types'

const roleCodes: Record<string, string> = {
  'back-panel': 'B',
  'vertical-side': 'S',
  'horizontal-deck': 'H',
  'door-front': 'O',
  'drawer-front': 'D',
  'drawer-side': 'D',
  'drawer-back': 'D',
  'drawer-bottom': 'D',
  leg: 'P',
  'top-panel': 'T',
}

export function panelRoleLabel(role: string): string {
  const labels: Record<PanelRole, string> = {
    'vertical-side': 'Lateral o división',
    'horizontal-deck': 'Panel horizontal',
    'back-panel': 'Fondo',
    'door-front': 'Puerta',
    'drawer-front': 'Frente de cajón',
    'drawer-side': 'Lateral de cajón',
    'drawer-back': 'Trasera de cajón',
    'drawer-bottom': 'Fondo de cajón',
    leg: 'Pata',
    'top-panel': 'Tapa exterior',
  }
  return labels[role as PanelRole] ?? role
}

export function panelCutlistOrientation(panel: CompiledPanel): string {
  if (panel.orientation === 'horizontal-xz') return 'horizontal'
  if (panel.orientation === 'vertical-yz') return 'vertical'
  if (panel.role === 'vertical-side' || panel.role === 'leg') return 'vertical'
  if (panel.role === 'horizontal-deck') return 'horizontal'
  return 'front'
}

export function panelRoleGroup(role: string): string {
  return role.startsWith('drawer-') ? 'drawer' : role
}

export function panelRoleCode(role: string): string {
  return roleCodes[role] ?? (role.match(/[a-z]/i)?.[0] ?? 'P').toUpperCase()
}

export function panelGroupIds(rows: { role?: PanelRole, representative?: { role: PanelRole } }[]): string[] {
  const counts = new Map<string, number>()
  return rows.map((row) => {
    const role = row.role ?? row.representative?.role ?? 'panel'
    const key = panelRoleGroup(role)
    const next = (counts.get(key) ?? 0) + 1
    counts.set(key, next)
    return `${panelRoleCode(role)}${next}`
  })
}

export function panelOperationSignature(panelKey: string, operations: PanelOperation[]): string {
  return operations
    .filter(op => op.targetPanelKey === panelKey)
    .map(op => [
      op.operationType,
      op.face ?? '',
      (op.center?.x ?? op.cx ?? op.x ?? 0).toFixed(6),
      (op.center?.y ?? op.cy ?? op.y ?? 0).toFixed(6),
      (op.diameter ?? 0).toFixed(6),
      (op.width ?? 0).toFixed(6),
      (op.height ?? 0).toFixed(6),
      (op.length ?? 0).toFixed(6),
      (op.depth ?? 0).toFixed(6),
      (op.rotation ?? 0).toFixed(9),
      (op.through ?? op.operationType === 'through-hole') ? '1' : '0',
    ].join(':'))
    .sort()
    .join('|')
}

export function panelCutlistSignature(panel: CompiledPanel, operations: PanelOperation[]): string {
  return [
    panel.role,
    panelCutlistOrientation(panel),
    Math.max(0, panel.width).toFixed(6),
    Math.max(0, panel.height).toFixed(6),
    Math.max(0, panel.thickness).toFixed(6),
    panelOperationSignature(panel.key, operations),
  ].join('|')
}

export function orientationLabel(orientation: string): string {
  return ({ vertical: 'Vertical', horizontal: 'Horizontal', front: 'Frontal' } as Record<string, string>)[orientation] ?? orientation
}

export interface CutlistPanelGroup {
  key: string
  groupId: string
  representative: CompiledPanel
  panelKeys: string[]
  operations: PanelOperation[]
  quantity: number
  orientation: string
  width: number
  height: number
  thickness: number
}

/** La tabla y las fichas comparten agrupación, orden e identificadores. */
export function groupCutlistPanels(panels: CompiledPanel[], operations: PanelOperation[]): CutlistPanelGroup[] {
  const groups = new Map<string, Omit<CutlistPanelGroup, 'groupId'>>()
  for (const panel of panels) {
    const key = panelCutlistSignature(panel, operations)
    const existing = groups.get(key)
    if (existing) {
      existing.quantity++
      existing.panelKeys.push(panel.key)
      continue
    }
    groups.set(key, {
      key, representative: panel, panelKeys: [panel.key],
      operations: operations.filter(op => op.targetPanelKey === panel.key),
      quantity: 1, orientation: panelCutlistOrientation(panel),
      width: panel.width, height: panel.height, thickness: panel.thickness,
    })
  }
  const rows = [...groups.values()].sort((a, b) =>
    a.representative.role.localeCompare(b.representative.role)
    || a.orientation.localeCompare(b.orientation)
    || b.width - a.width || b.height - a.height || b.thickness - a.thickness
    || a.key.localeCompare(b.key),
  )
  const ids = panelGroupIds(rows)
  return rows.map((row, index) => ({ ...row, groupId: ids[index] }))
}

export interface CutlistOperationRow {
  key: string
  groupId: string
  operationType: PanelOperation['operationType']
  targetRole: PanelRole
  face: string
  diameter: number | null
  depth: number | null
  width: number | null
  length: number | null
  x: number
  y: number
  rotation: number
  through: boolean
  quantity: number
}

export function groupCutlistOperations(groups: CutlistPanelGroup[], operations: PanelOperation[]): CutlistOperationRow[] {
  const byPanel = new Map(groups.flatMap(group => group.panelKeys.map(key => [key, group] as const)))
  const rows = new Map<string, CutlistOperationRow>()
  for (const op of operations) {
    const group = byPanel.get(op.targetPanelKey)
    if (!group) continue
    const signature = panelOperationSignature(op.targetPanelKey, [op])
    const key = `${group.groupId}:${signature}`
    const existing = rows.get(key)
    if (existing) { existing.quantity++; continue }
    rows.set(key, {
      key, groupId: group.groupId, targetRole: group.representative.role,
      operationType: op.operationType, face: op.face ?? 'front',
      diameter: op.diameter ?? null, depth: op.depth ?? null,
      width: op.operationType === 'rail-cut' ? op.length != null ? op.width ?? null : op.height ?? null : null,
      length: op.operationType === 'rail-cut' ? op.length ?? op.width ?? null : null,
      x: op.center?.x ?? op.cx ?? op.x ?? 0,
      y: op.center?.y ?? op.cy ?? op.y ?? 0,
      rotation: (op.rotation ?? 0) * 180 / Math.PI,
      through: op.through ?? op.operationType === 'through-hole', quantity: 1,
    })
  }
  return [...rows.values()].sort((a, b) => a.groupId.localeCompare(b.groupId, undefined, { numeric: true }) || a.key.localeCompare(b.key))
}
