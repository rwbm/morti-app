import type { FurnitureColumn, FurnitureConfig } from './types'
import { normalizeConstruction } from './construction'
import { moduleFrontThickness } from './thickness'

export interface CellBounds {
  moduleId: string
  columnIndex: number
  moduleIndex: number
  width: number
  height: number
  depth: number
  frontWidth: number
  frontHeight: number
}

export interface CompiledCellBounds extends CellBounds {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  zMin: number
  zMax: number
  frontZ: number
}

export function buildCellGrid(columns: FurnitureColumn[], config: FurnitureConfig, construction = normalizeConstruction(undefined)): CompiledCellBounds[][] {
  const totalWidth = columns.reduce((sum, column) => sum + column.width, 0)
  const halfWidth = totalWidth / 2
  const cells: CompiledCellBounds[][] = []
  let cursorX = 0

  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex]
    const columnWidth = column.width
    const columnCenterX = cursorX + columnWidth / 2 - halfWidth
    cursorX += columnWidth

    const columnCells: CompiledCellBounds[] = []
    let moduleBaseY = 0
    for (let moduleIndex = 0; moduleIndex < column.modules.length; moduleIndex++) {
      const module = column.modules[moduleIndex]
      const moduleTopY = moduleBaseY + module.height
      const xMin = columnCenterX - columnWidth / 2 + config.panelThickness / 2 + config.panelJointClearance
      const xMax = columnCenterX + columnWidth / 2 - config.panelThickness / 2 - config.panelJointClearance
      const yMin = moduleBaseY + config.panelThickness / 2 + config.panelJointClearance
      const yMax = moduleTopY - config.panelThickness / 2 - config.panelJointClearance
      const zMin = -config.depth / 2 + (construction.back ? config.backPanelInset + config.backPanelThickness : 0) + config.panelJointClearance
      const zMax = config.depth / 2 - config.panelJointClearance
      columnCells.push({
        moduleId: module.id,
        columnIndex,
        moduleIndex,
        xMin,
        xMax,
        yMin,
        yMax,
        zMin,
        zMax,
        width: xMax - xMin,
        height: yMax - yMin,
        depth: zMax - zMin,
        frontZ: config.depth / 2 - moduleFrontThickness(module, config) / 2,
        frontWidth: xMax - xMin - 2 * config.frontClearance,
        frontHeight: yMax - yMin - 2 * config.frontClearance,
      })
      moduleBaseY = moduleTopY
    }
    cells.push(columnCells)
  }

  return cells
}
