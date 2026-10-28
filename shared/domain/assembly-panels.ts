import { drawerDepthBounds, drawerGrooveDepth, moduleFrontThickness, inheritedThicknesses } from './thickness'
import { buildCellGrid, type CompiledCellBounds } from './layout'
import { constructionBodyLift, legCenters, normalizeConstruction } from './construction'
import { interiorOpeningHeight, interiorShelfCount } from './interior'
import { validateFurnitureDocIssues } from './assembly-validation-core'
import type {
  CompiledAssembly,
  CompiledPanel,
  FurnitureColumn,
  FurnitureConfig,
  FurnitureDoc,
  FurnitureModule,
  PanelOperation,
  PanelRole,
} from '~~/shared/domain/types'

// ---------------------------------------------------------------------------
// Tunables (mirrors Dt_x5Iy5.js module-level constants)
// ---------------------------------------------------------------------------

const HOLE_MIN_DIAMETER = 5e-4 // 0.5 mm clamp
const RAILCUT_MIN_SIZE = 5e-4
const PULL_HOLE_DEPTH_PADDING = 1e-6
const DEGENERATE_MIN_SIZE = 0.001

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface CompileOptions {
  // Reserved — currently no toggles. Door / drawer animation is applied at the
  // canvas layer, not in the compiler.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function panelKey(columnIndex: number, moduleIndex: number, role: PanelRole, suffix?: string): string {
  return suffix
    ? `${columnIndex}-${moduleIndex}-${role}-${suffix}`
    : `${columnIndex}-${moduleIndex}-${role}`
}

function columnInteriorWidth(column: FurnitureColumn, config: FurnitureConfig): number {
  return Math.max(0.001, column.width - 2 * config.panelThickness)
}

function columnTotalHeight(column: FurnitureColumn): number {
  let h = 0
  for (const m of column.modules) h += Math.max(0, m.height)
  return Math.max(0.001, h)
}

// ---------------------------------------------------------------------------
// Compile assembly (ported from the original Morti assembly generator)
// ---------------------------------------------------------------------------

// La entrada se edita en mm, pero los encastres y repartos producen fracciones.
const METRIC_SNAP = 0.000001
const METRIC_SNAP_MULTIPLIER = Math.round(1 / METRIC_SNAP)

function snapMetric(value: number): number {
  return Number.isFinite(value) ? Math.round(value * METRIC_SNAP_MULTIPLIER) / METRIC_SNAP_MULTIPLIER : 0
}

function positiveMetric(value: number): number {
  return Math.max(DEGENERATE_MIN_SIZE, snapMetric(value))
}

function panelRotation(orientation: NonNullable<CompiledPanel['orientation']>): [number, number, number] {
  if (orientation === 'horizontal-xz') return [-Math.PI / 2, 0, 0]
  if (orientation === 'vertical-yz') return [0, Math.PI / 2, 0]
  return [0, 0, 0]
}

function makePanel(args: {
  key: string
  role: PanelRole
  position: { x: number, y: number, z: number }
  size: { width: number, height: number, thickness: number }
  orientation: NonNullable<CompiledPanel['orientation']>
  sourceModuleId?: string
  doorHinge?: 'left' | 'right'
  touchedModuleIds?: string[]
}): CompiledPanel {
  return {
    key: args.key,
    role: args.role,
    width: args.size.width,
    height: args.size.height,
    thickness: args.size.thickness,
    position: [args.position.x, args.position.y, args.position.z],
    rotation: panelRotation(args.orientation),
    operations: [],
    orientation: args.orientation,
    sourceModuleId: args.sourceModuleId,
    doorHinge: args.doorHinge,
    touchedModuleIds: args.touchedModuleIds,
  }
}


function moduleIdsAtBoundary(columns: FurnitureColumn[], columnIndex: number): string[] {
  if (columnIndex < 0 || columnIndex >= columns.length) return []
  return columns[columnIndex].modules.map(module => module.id)
}

function clampOperationCenter(panelWidth: number, panelHeight: number, diameter: number, x: number, y: number) {
  const radius = Math.max(0, diameter / 2)
  const halfWidth = panelWidth / 2
  const halfHeight = panelHeight / 2
  const minX = -halfWidth + radius
  const maxX = halfWidth - radius
  const minY = -halfHeight + radius
  const maxY = halfHeight - radius
  return {
    x: minX > maxX ? 0 : Math.min(maxX, Math.max(minX, x)),
    y: minY > maxY ? 0 : Math.min(maxY, Math.max(minY, y)),
  }
}

function makePullHole(panel: CompiledPanel, requestedCenter: { x: number, y: number }, diameter: number, suffix: string): PanelOperation {
  const center = clampOperationCenter(panel.width, panel.height, diameter, requestedCenter.x, requestedCenter.y)
  return {
    id: `op:pull-hole:${panel.key}:${suffix}`,
    operationType: 'through-hole',
    targetPanelKey: panel.key,
    face: 'front',
    center,
    cx: center.x,
    cy: center.y,
    diameter,
    depth: panel.thickness,
    through: true,
    sourceModuleId: panel.sourceModuleId,
  }
}

function backPanelGrooveDepth(config: FurnitureConfig): number {
  return config.panelThickness * 0.25
}

function makeVerticalSide(boundaryIndex: number, x: number, height: number, config: FurnitureConfig, touchedModuleIds: string[]): CompiledPanel {
  const overhang = config.sidePanelOverhang
  return makePanel({
    key: `vertical:boundary:${boundaryIndex}`,
    role: 'vertical-side',
    position: { x, y: height / 2, z: 0 },
    size: { width: config.depth, height: height + 2 * overhang, thickness: config.panelThickness },
    orientation: 'vertical-yz',
    touchedModuleIds,
  })
}

function makeHorizontalDeck(
  columnIndex: number,
  boundaryIndex: number,
  x: number,
  y: number,
  columnWidth: number,
  config: FurnitureConfig,
  touchedModuleIds: string[],
): CompiledPanel {
  const depth = config.depth + config.sidePanelOverhang / 2
  const usableWidth = Math.max(DEGENERATE_MIN_SIZE, columnWidth - config.panelThickness - 2 * config.panelJointClearance)
  return makePanel({
    key: `horizontal:column:${columnIndex}:boundary:${boundaryIndex}`,
    role: 'horizontal-deck',
    position: { x, y, z: config.sidePanelOverhang / 4 },
    size: { width: usableWidth, height: depth, thickness: config.panelThickness },
    orientation: 'horizontal-xz',
    touchedModuleIds,
  })
}

function makeBackPanel(module: FurnitureModule, cell: CompiledCellBounds, config: FurnitureConfig): CompiledPanel {
  const reserve = backPanelGrooveDepth(config)
  return makePanel({
    key: `back:column:${cell.columnIndex}:module:${cell.moduleIndex}`,
    role: 'back-panel',
    sourceModuleId: module.id,
    position: {
      x: (cell.xMin + cell.xMax) / 2,
      y: (cell.yMin + cell.yMax) / 2,
      z: -config.depth / 2 + config.backPanelInset + config.backPanelThickness / 2,
    },
    size: {
      width: Math.max(DEGENERATE_MIN_SIZE, cell.width + 2 * reserve),
      height: Math.max(DEGENERATE_MIN_SIZE, cell.height + 2 * reserve),
      thickness: config.backPanelThickness,
    },
    orientation: 'vertical-xy',
    touchedModuleIds: [module.id],
  })
}

function makeBackGrooveOperation(backPanel: CompiledPanel, targetPanel: CompiledPanel, target: 'left-side' | 'right-side' | 'bottom-deck' | 'top-deck', config: FurnitureConfig): PanelOperation {
  const reserve = backPanelGrooveDepth(config)
  const grooveWidth = config.backPanelThickness + config.backPanelGrooveClearance
  const isSide = target === 'left-side' || target === 'right-side'
  let length: number
  let rotation: number
  let centerX: number
  let centerY: number

  if (isSide) {
    length = Math.max(DEGENERATE_MIN_SIZE, backPanel.height)
    rotation = Math.PI / 2
    centerX = -(backPanel.position[2] - targetPanel.position[2])
    centerY = backPanel.position[1] - targetPanel.position[1]
  }
  else {
    length = Math.max(DEGENERATE_MIN_SIZE, Math.min(targetPanel.width, backPanel.width))
    rotation = 0
    centerX = backPanel.position[0] - targetPanel.position[0]
    centerY = -(backPanel.position[2] - targetPanel.position[2])
  }

  const face = target === 'left-side' || target === 'bottom-deck' ? 'front' : 'back'
  return {
    id: `op:rail-cut:${backPanel.key}:${target}`,
    operationType: 'rail-cut',
    targetPanelKey: targetPanel.key,
    face,
    center: { x: centerX, y: centerY },
    x: centerX,
    y: centerY,
    width: grooveWidth,
    length,
    height: grooveWidth,
    depth: reserve,
    rotation,
    sourceModuleId: backPanel.sourceModuleId,
  }
}

function makeDrawerBottomGrooveOperation(
  drawerBottom: CompiledPanel,
  targetPanel: CompiledPanel,
  target: 'left-side' | 'right-side' | 'back' | 'front',
  cell: CompiledCellBounds,
  config: FurnitureConfig,
): PanelOperation {
  const reserve = drawerGrooveDepth(config)
  const grooveWidth = config.drawerBottomThickness + config.backPanelGrooveClearance
  const panelThickness = config.drawerPanelThickness
  let face: 'front' | 'back'
  let length: number
  let centerX: number
  let centerY: number

  if (target === 'left-side' || target === 'right-side') {
    face = target === 'left-side' ? 'front' : 'back'
    length = Math.max(DEGENERATE_MIN_SIZE, targetPanel.width)
    centerX = -(drawerBottom.position[2] - targetPanel.position[2])
    centerY = drawerBottom.position[1] - targetPanel.position[1]
  }
  else if (target === 'back') {
    face = 'front'
    length = Math.max(DEGENERATE_MIN_SIZE, targetPanel.width)
    centerX = drawerBottom.position[0] - targetPanel.position[0]
    centerY = drawerBottom.position[1] - targetPanel.position[1]
  }
  else {
    face = 'back'
    length = Math.max(DEGENERATE_MIN_SIZE, cell.width - 2 * panelThickness + 2 * reserve)
    centerX = drawerBottom.position[0] - targetPanel.position[0]
    centerY = drawerBottom.position[1] - targetPanel.position[1]
  }

  return {
    id: `op:rail-cut:${drawerBottom.key}:${target}`,
    operationType: 'rail-cut',
    targetPanelKey: targetPanel.key,
    face,
    center: { x: centerX, y: centerY },
    x: centerX,
    y: centerY,
    width: grooveWidth,
    length,
    height: grooveWidth,
    depth: reserve,
    rotation: 0,
    sourceModuleId: drawerBottom.sourceModuleId,
  }
}

function compileDoorOrFrontPanels(module: FurnitureModule, cell: CompiledCellBounds, config: FurnitureConfig) {
  const panels: CompiledPanel[] = []
  const operations: PanelOperation[] = []
  const frontClearance = config.frontClearance
  const centerX = (cell.xMin + cell.xMax) / 2
  const centerY = (cell.yMin + cell.yMax) / 2
  const frontHeight = Math.max(DEGENERATE_MIN_SIZE, cell.frontHeight)
  const diameter = config.pullHoleDiameter
  const inset = config.pullHoleEdgeInset

  function singleDoorPull(panel: CompiledPanel, hinge: 'left' | 'right') {
    const x = hinge === 'left' ? panel.width / 2 - inset : -panel.width / 2 + inset
    const y = panel.height / 2 - inset
    return { x, y }
  }

  function pairedDoorPull(panel: CompiledPanel, side: 'left' | 'right') {
    const xFromCenter = panel.width / 2 + frontClearance - config.pullHolePairGap / 2
    const x = side === 'left' ? xFromCenter : -xFromCenter
    const y = panel.height / 2 - inset
    return { x, y }
  }

  if (module.type === 'left-door' || module.type === 'right-door') {
    const width = Math.max(DEGENERATE_MIN_SIZE, cell.frontWidth)
    const hinge = module.type === 'left-door' ? 'left' : 'right'
    const panel = makePanel({
      key: `door-front:${module.id}`,
      role: 'door-front',
      sourceModuleId: module.id,
      doorHinge: hinge,
      position: { x: centerX, y: centerY, z: cell.frontZ },
      size: { width, height: frontHeight, thickness: config.doorThickness ?? config.panelThickness },
      orientation: 'vertical-xy',
    })
    panels.push(panel)
    operations.push(makePullHole(panel, singleDoorPull(panel, hinge), diameter, 'a'))
    return { panels, operations }
  }

  if (module.type === 'doors') {
    const width = Math.max(DEGENERATE_MIN_SIZE, (cell.frontWidth - 2 * frontClearance) / 2)
    const leftX = centerX - width / 2 - frontClearance
    const rightX = centerX + width / 2 + frontClearance
    const left = makePanel({
      key: `door-front:${module.id}:left`,
      role: 'door-front',
      sourceModuleId: module.id,
      doorHinge: 'left',
      position: { x: leftX, y: centerY, z: cell.frontZ },
      size: { width, height: frontHeight, thickness: config.doorThickness ?? config.panelThickness },
      orientation: 'vertical-xy',
    })
    const right = makePanel({
      key: `door-front:${module.id}:right`,
      role: 'door-front',
      sourceModuleId: module.id,
      doorHinge: 'right',
      position: { x: rightX, y: centerY, z: cell.frontZ },
      size: { width, height: frontHeight, thickness: config.doorThickness ?? config.panelThickness },
      orientation: 'vertical-xy',
    })
    panels.push(left, right)
    operations.push(makePullHole(left, pairedDoorPull(left, 'left'), diameter, 'a'))
    operations.push(makePullHole(right, pairedDoorPull(right, 'right'), diameter, 'a'))
  }

  return { panels, operations }
}

function compileDrawer(module: FurnitureModule, cell: CompiledCellBounds, config: FurnitureConfig) {
  const panels: CompiledPanel[] = []
  const operations: PanelOperation[] = []
  const drawerCount = Math.max(1, Math.floor(module.drawerCount ?? 1))
  const panelThickness = config.drawerPanelThickness
  const backThickness = config.drawerBottomThickness
  const jointClearance = config.panelJointClearance
  const drawerBottomInset = config.drawerBottomInset
  const backInset = config.backPanelInset
  const frontClearance = config.frontClearance
  const centerX = (cell.xMin + cell.xMax) / 2
  const frontBandHeight = (cell.height - frontClearance * (drawerCount + 1)) / drawerCount
  const frontHeight = Math.max(DEGENERATE_MIN_SIZE, frontBandHeight)
  const spacing = 2 * jointClearance
  const drawerBoxBandHeight = (cell.height - spacing * Math.max(0, drawerCount - 1)) / drawerCount
  const depthBounds = drawerDepthBounds(cell, config)
  const drawerSideWidth = Math.max(DEGENERATE_MIN_SIZE, depthBounds.sideLength)
  const drawerBoxCenterZ = depthBounds.centerZ
  const reserve = drawerGrooveDepth(config)
  const bottomWidth = Math.max(DEGENERATE_MIN_SIZE, cell.width - 2 * jointClearance - 2 * panelThickness + 2 * reserve)
  const leftSideX = cell.xMin + panelThickness / 2 + jointClearance
  const rightSideX = cell.xMax - panelThickness / 2 - jointClearance
  const backZ = depthBounds.backOuter + panelThickness / 2

  for (let drawerIndex = 0; drawerIndex < drawerCount; drawerIndex++) {
    const frontY = cell.yMin + frontClearance + drawerIndex * (frontHeight + frontClearance) + frontHeight / 2
    const drawerBandBottom = cell.yMin + drawerIndex * (drawerBoxBandHeight + spacing)
    const drawerBandTop = drawerBandBottom + drawerBoxBandHeight
    const usableBottom = drawerBandBottom + drawerBottomInset + jointClearance
    const usableTop = drawerBandTop - drawerBottomInset - jointClearance
    const drawerBoxHeight = Math.max(DEGENERATE_MIN_SIZE, usableTop - usableBottom)
    const drawerBoxCenterY = (usableBottom + usableTop) / 2
    const drawerBottomY = usableBottom + backInset + backThickness / 2
    const front = makePanel({
      key: `drawer-front:${module.id}:${drawerIndex}`,
      role: 'drawer-front',
      sourceModuleId: module.id,
      position: { x: centerX, y: frontY, z: cell.frontZ },
      size: { width: cell.frontWidth, height: frontHeight, thickness: config.drawerFrontThickness },
      orientation: 'vertical-xy',
    })
    panels.push(front)
    const pullY = frontHeight / 2 - config.pullHoleEdgeInset
    operations.push(
      makePullHole(front, { x: -config.pullHolePairGap / 2, y: pullY }, config.pullHoleDiameter, 'left'),
      makePullHole(front, { x: config.pullHolePairGap / 2, y: pullY }, config.pullHoleDiameter, 'right'),
    )

    const leftSide = makePanel({
      key: `drawer-side:${module.id}:${drawerIndex}:left`,
      role: 'drawer-side',
      sourceModuleId: module.id,
      position: { x: leftSideX, y: drawerBoxCenterY, z: drawerBoxCenterZ },
      size: { width: drawerSideWidth, height: drawerBoxHeight, thickness: panelThickness },
      orientation: 'vertical-yz',
    })
    const rightSide = makePanel({
      key: `drawer-side:${module.id}:${drawerIndex}:right`,
      role: 'drawer-side',
      sourceModuleId: module.id,
      position: { x: rightSideX, y: drawerBoxCenterY, z: drawerBoxCenterZ },
      size: { width: drawerSideWidth, height: drawerBoxHeight, thickness: panelThickness },
      orientation: 'vertical-yz',
    })
    const back = makePanel({
      key: `drawer-back:${module.id}:${drawerIndex}`,
      role: 'drawer-back',
      sourceModuleId: module.id,
      position: { x: centerX, y: drawerBoxCenterY, z: backZ },
      size: { width: front.width, height: drawerBoxHeight, thickness: panelThickness },
      orientation: 'vertical-xy',
    })
    const bottom = makePanel({
      key: `drawer-bottom:${module.id}:${drawerIndex}`,
      role: 'drawer-bottom',
      sourceModuleId: module.id,
      position: { x: centerX, y: drawerBottomY, z: drawerBoxCenterZ },
      size: { width: bottomWidth, height: drawerSideWidth + 2 * jointClearance + 2 * reserve, thickness: backThickness },
      orientation: 'horizontal-xz',
    })
    panels.push(leftSide, rightSide, back, bottom)
    operations.push(
      makeDrawerBottomGrooveOperation(bottom, leftSide, 'left-side', cell, config),
      makeDrawerBottomGrooveOperation(bottom, rightSide, 'right-side', cell, config),
      makeDrawerBottomGrooveOperation(bottom, back, 'back', cell, config),
      makeDrawerBottomGrooveOperation(bottom, front, 'front', cell, config),
    )
  }

  return { panels, operations }
}

function compileModule(module: FurnitureModule, cell: CompiledCellBounds, config: FurnitureConfig) {
  if (module.type === 'drawer') return compileDrawer(module, cell, config)
  const compiled = compileDoorOrFrontPanels(module, cell, config)
  const count = interiorShelfCount(module)
  const opening = interiorOpeningHeight(module, config, cell.height)
  // Stop short of the front panel so shelves cannot intersect closed doors.
  const rear = cell.zMin
  const front = cell.frontZ - moduleFrontThickness(module, config) / 2 - config.frontClearance
  for (let i = 0; i < count; i++) {
    compiled.panels.push(makePanel({
      key: `interior-shelf:${module.id}:${i}`,
      role: 'horizontal-deck',
      sourceModuleId: module.id,
      touchedModuleIds: [module.id],
      position: {
        x: (cell.xMin + cell.xMax) / 2,
        y: cell.yMin + opening * (i + 1) + config.panelThickness * (i + 0.5),
        z: (rear + front) / 2,
      },
      size: { width: cell.width, height: Math.max(DEGENERATE_MIN_SIZE, front - rear), thickness: config.panelThickness },
      orientation: 'horizontal-xz',
    }))
  }
  return compiled
}

function normalizeOperation(operation: PanelOperation): PanelOperation {
  const center = operation.center
  const normalized: PanelOperation = {
    ...operation,
    center: center ? { x: center.x, y: center.y } : undefined,
  }
  if (normalized.center) {
    if (normalized.operationType === 'through-hole') {
      normalized.cx = normalized.center.x
      normalized.cy = normalized.center.y
    }
    else {
      normalized.x = normalized.center.x
      normalized.y = normalized.center.y
    }
  }
  if (normalized.diameter != null) normalized.diameter = snapMetric(normalized.diameter)
  if (normalized.depth != null) normalized.depth = snapMetric(normalized.depth)
  if (normalized.width != null) normalized.width = snapMetric(normalized.width)
  if (normalized.height != null) normalized.height = snapMetric(normalized.height)
  if (normalized.length != null) normalized.length = snapMetric(normalized.length)
  return normalized
}

function normalizePanel(panel: CompiledPanel, yOffset: number): CompiledPanel {
  return {
    ...panel,
    width: positiveMetric(panel.width),
    height: positiveMetric(panel.height),
    thickness: positiveMetric(panel.thickness),
    position: [panel.position[0], snapMetric(panel.position[1] + yOffset), panel.position[2]],
    operations: [],
  }
}

export function compileNominalAssembly(furnitureDoc: FurnitureDoc, validate = true): CompiledAssembly {
  const config = { ...furnitureDoc.config, ...inheritedThicknesses(furnitureDoc.config) }
  const columns = furnitureDoc.columns
  if (columns.length === 0) return { panels: [], operations: [], issues: [] }

  const totalWidth = columns.reduce((sum, column) => sum + column.width, 0)
  if (!(totalWidth > 0)) return { panels: [], operations: [], issues: [] }

  const columnHeights = columns.map(column => column.modules.reduce((sum, module) => sum + module.height, 0))
  const construction = normalizeConstruction(furnitureDoc.construction)
  const cells = buildCellGrid(columns, config, construction)
  const issues = validate ? validateFurnitureDocIssues(furnitureDoc) : []
  const panels: CompiledPanel[] = []
  const operations: PanelOperation[] = []
  const columnBoundaries = [0]

  for (const column of columns) columnBoundaries.push(columnBoundaries[columnBoundaries.length - 1] + column.width)

  const halfWidth = totalWidth / 2
  for (let boundaryIndex = 0; boundaryIndex < columnBoundaries.length; boundaryIndex++) {
    const x = columnBoundaries[boundaryIndex] - halfWidth
    const leftHeight = boundaryIndex > 0 ? columnHeights[boundaryIndex - 1] : 0
    const rightHeight = boundaryIndex < columnHeights.length ? columnHeights[boundaryIndex] : 0
    const sideHeight = Math.max(leftHeight, rightHeight)
    const touchedModuleIds = [...moduleIdsAtBoundary(columns, boundaryIndex - 1), ...moduleIdsAtBoundary(columns, boundaryIndex)]
    if (boundaryIndex === 0 && !construction.leftSide) continue
    if (boundaryIndex === columnBoundaries.length - 1 && !construction.rightSide) continue
    panels.push(makeVerticalSide(boundaryIndex, x, sideHeight, config, touchedModuleIds))
  }

  let cursorX = 0
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex]
    const columnCenterX = cursorX + column.width / 2 - halfWidth
    cursorX += column.width
    if (column.modules.length === 0) continue

    const moduleBoundaries = [0]
    let y = 0
    for (const module of column.modules) {
      y += module.height
      moduleBoundaries.push(y)
    }

    for (let boundaryIndex = 0; boundaryIndex < moduleBoundaries.length; boundaryIndex++) {
      if (boundaryIndex === 0 && !construction.bottom) continue
      if (boundaryIndex === moduleBoundaries.length - 1 && (!construction.top || construction.topMode === 'overlay')) continue
      let touchedModuleIds: string[]
      if (boundaryIndex === 0) touchedModuleIds = [column.modules[0].id]
      else if (boundaryIndex === column.modules.length) touchedModuleIds = [column.modules[column.modules.length - 1].id]
      else touchedModuleIds = [column.modules[boundaryIndex - 1].id, column.modules[boundaryIndex].id]
      panels.push(makeHorizontalDeck(columnIndex, boundaryIndex, columnCenterX, moduleBoundaries[boundaryIndex], column.width, config, touchedModuleIds))
    }

    for (let moduleIndex = 0; moduleIndex < column.modules.length; moduleIndex++) {
      const module = column.modules[moduleIndex]
      const cell = cells[columnIndex]?.[moduleIndex]
      if (!cell) continue
      if (construction.back) panels.push(makeBackPanel(module, cell, config))
      const compiled = compileModule(module, cell, config)
      panels.push(...compiled.panels)
      operations.push(...compiled.operations)
    }
  }

  if (construction.top && construction.topMode !== 'inset') {
    const overhang = construction.topOverhang
    panels.push(makePanel({
      key: `top:${construction.topMode}`,
      role: 'top-panel',
      position: { x: 0, y: Math.max(...columnHeights) + config.sidePanelOverhang + config.panelThickness / 2, z: config.sidePanelOverhang / 4 },
      size: { width: totalWidth + config.panelThickness + 2 * overhang, height: config.depth + config.sidePanelOverhang / 2 + 2 * overhang, thickness: config.panelThickness },
      orientation: 'horizontal-xz',
      touchedModuleIds: columns.flatMap(column => column.modules.slice(-1).map(module => module.id)),
    }))
  }

  const panelMap = new Map(panels.map(panel => [panel.key, panel]))
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex]
    for (let moduleIndex = 0; moduleIndex < column.modules.length; moduleIndex++) {
      const cell = cells[columnIndex]?.[moduleIndex]
      if (!cell) continue
      const backPanel = panelMap.get(`back:column:${columnIndex}:module:${moduleIndex}`)
      if (!backPanel) continue
      const targets = [
        { key: `vertical:boundary:${columnIndex}`, target: 'left-side' as const },
        { key: `vertical:boundary:${columnIndex + 1}`, target: 'right-side' as const },
        { key: `horizontal:column:${columnIndex}:boundary:${moduleIndex}`, target: 'bottom-deck' as const },
        { key: `horizontal:column:${columnIndex}:boundary:${moduleIndex + 1}`, target: 'top-deck' as const },
      ]
      for (const { key, target } of targets) {
        const targetPanel = panelMap.get(key)
          ?? (construction.top && construction.topMode === 'overlay' && target === 'top-deck' && moduleIndex === column.modules.length - 1 && Math.abs(columnHeights[columnIndex] - Math.max(...columnHeights)) < 1e-6 ? panelMap.get('top:overlay') : undefined)
        if (targetPanel) operations.push(makeBackGrooveOperation(backPanel, targetPanel, target, config))
      }
    }
  }

  const lift = constructionBodyLift(construction, config)
  const normalizedPanels = panels.map(panel => normalizePanel(panel, config.sidePanelOverhang + lift))
  if (construction.legs.enabled) {
    let left = -totalWidth / 2
    for (let ci = 0; ci < columns.length; ci++) {
      const column = columns[ci]
      const center = left + column.width / 2
      left += column.width
      if (!column.modules.length) continue
      const centers = legCenters(column.width, config.depth, config, construction)
      for (let xi = 0; xi < 2; xi++) {
        for (let zi = 0; zi < 2; zi++) {
          normalizedPanels.push(normalizePanel(makePanel({
            key: `leg:column:${ci}:${xi}:${zi}`,
            role: 'leg',
            position: { x: center + centers.x[xi], y: construction.legs.height / 2, z: centers.z[zi] },
            size: { width: construction.legs.width, height: construction.legs.height, thickness: construction.legs.width },
            orientation: 'vertical-xy',
            touchedModuleIds: [column.modules[0].id],
          }), 0))
        }
      }
    }
  }
  const normalizedOperations = operations.map(normalizeOperation)
  const normalizedPanelMap = new Map(normalizedPanels.map(panel => [panel.key, panel]))
  for (const operation of normalizedOperations) {
    normalizedPanelMap.get(operation.targetPanelKey)?.operations.push(operation)
  }

  return { panels: normalizedPanels, operations: normalizedOperations, issues }
}
