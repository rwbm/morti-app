import { drawerDepthBounds, moduleFrontThickness, THICKNESS_FIELDS, inheritedThicknesses } from './thickness'
import { buildCellGrid, type CellBounds, type CompiledCellBounds } from './layout'
import { floorUnderside, legCenters, normalizeConstruction } from './construction'
import type {
  CompiledAssemblyIssue,
  FurnitureColumn,
  FurnitureConfig,
  FurnitureDoc,
  FurnitureConstruction,
} from '~~/shared/domain/types'
import { interiorOpeningHeight, interiorShelfCount } from './interior'

const DEGENERATE_MIN_SIZE = 0.001

function makeIssue(
  code: string,
  message: string,
  cell?: CellBounds,
  severity: CompiledAssemblyIssue['severity'] = 'error',
): CompiledAssemblyIssue {
  return {
    severity,
    code,
    message,
    moduleId: cell?.moduleId,
    columnIndex: cell?.columnIndex,
    moduleIndex: cell?.moduleIndex,
  }
}


function validateCompiledCells(columns: FurnitureColumn[], cells: CompiledCellBounds[][], config: FurnitureConfig, construction: FurnitureConstruction): CompiledAssemblyIssue[] {
  const issues: CompiledAssemblyIssue[] = []
  const columnHeights = columns.map(column => column.modules.reduce((sum, module) => sum + module.height, 0))
  if (construction.top && construction.topMode !== 'inset' && columnHeights.length > 1 && Math.max(...columnHeights) - Math.min(...columnHeights) > 0.00001) {
    issues.push(makeIssue('top-uneven-columns', 'Las columnas tienen distinta altura y quedarán huecos bajo la cubierta continua.', undefined, 'warning'))
  }
  for (const field of THICKNESS_FIELDS) {
    const value = config[field.key]
    if (!Number.isFinite(value) || value <= 0) issues.push(makeIssue(`invalid-thickness-${field.key}`, `El espesor de ${field.label.toLowerCase()} debe ser mayor que cero.`))
  }
  if (construction.back && config.backPanelInset + config.backPanelThickness + config.panelJointClearance >= config.depth) {
    issues.push(makeIssue('back-reserve-overflows-depth', 'El retiro del fondo, su espesor y la holgura superan la profundidad del mueble.'))
  }
  if (construction.legs.enabled) {
    if (!construction.bottom) issues.push(makeIssue('legs-require-bottom', 'Las patas requieren un piso donde apoyarse. Activá el piso o quitá las patas.'))
    if (construction.legs.height <= floorUnderside(config)) {
      issues.push(makeIssue('legs-too-short', 'Aumentá el alto de las patas o reducí la prolongación de los laterales.'))
    }
    for (const [columnIndex, column] of columns.entries()) {
      if (!column.modules.length) continue
      const centers = legCenters(column.width, config.depth, config, construction)
      if (centers.x[1] - centers.x[0] < construction.legs.width || centers.z[1] - centers.z[0] < construction.legs.width) {
        issues.push({ ...makeIssue('legs-do-not-fit', 'Las patas no caben bajo esta columna. Reducí su sección o retiro, o aumentá el ancho y la profundidad.'), columnIndex })
      }
    }
  }

  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex]
    const columnCells = cells[columnIndex] ?? []
    for (let moduleIndex = 0; moduleIndex < column.modules.length; moduleIndex++) {
      const module = column.modules[moduleIndex]
      const cell = columnCells[moduleIndex]
      if (!cell) continue
      if (interiorShelfCount(module) > 0 && interiorOpeningHeight(module, config, cell.height) < config.minModuleHeight) {
        issues.push(makeIssue('interior-openings-too-short', 'Reducí la cantidad de estantes o aumentá el alto del módulo para dejar espacio entre ellos.', cell))
      }
      if (interiorShelfCount(module) > 0 && cell.frontZ - moduleFrontThickness(module, config) / 2 - config.frontClearance - cell.zMin < DEGENERATE_MIN_SIZE) {
        issues.push(makeIssue('interior-shelf-too-shallow', 'La profundidad del módulo no alcanza para ubicar estantes detrás del frente.', cell))
      }
      if (cell.width < DEGENERATE_MIN_SIZE) issues.push(makeIssue('cell-too-narrow', 'El interior del módulo es demasiado angosto.', cell))
      if (cell.height < DEGENERATE_MIN_SIZE) issues.push(makeIssue('cell-too-short', 'El interior del módulo es demasiado bajo.', cell))
      if (cell.depth < DEGENERATE_MIN_SIZE) issues.push(makeIssue('cell-too-shallow', 'El interior del módulo tiene muy poca profundidad.', cell))
      if (cell.frontWidth < DEGENERATE_MIN_SIZE || cell.frontHeight < DEGENERATE_MIN_SIZE) {
        issues.push(makeIssue('front-degenerate', 'El frente del módulo es demasiado pequeño.', cell))
      }
      if (module.type === 'doors' && cell.frontWidth / 2 < DEGENERATE_MIN_SIZE) {
        issues.push(makeIssue('paired-door-too-narrow', 'Las hojas de puerta quedan demasiado angostas al descontar las holguras.', cell))
      }
      if (module.type === 'drawer') {
        if (config.drawerSlidesReserve >= cell.depth) {
          issues.push(makeIssue('slides-reserve-overflows-cell', 'La reserva para las correderas supera la profundidad del módulo.', cell))
        }
        const drawerCount = Math.max(1, Math.floor(module.drawerCount ?? 1))
        const frontBandHeight = (cell.height - config.frontClearance * (drawerCount + 1)) / drawerCount
        const drawerBoxBandHeight = (cell.height - 2 * config.panelJointClearance * Math.max(0, drawerCount - 1)) / drawerCount - 2 * config.drawerBottomInset - 2 * config.panelJointClearance
        const drawerBackBandHeight = drawerBoxBandHeight - config.backPanelInset - config.drawerBottomThickness
        if (frontBandHeight < DEGENERATE_MIN_SIZE || drawerBoxBandHeight < DEGENERATE_MIN_SIZE || drawerBackBandHeight < DEGENERATE_MIN_SIZE) {
          issues.push(makeIssue('drawer-band-too-short', 'El alto de cada cajón no alcanza para el frente, el fondo, los laterales y las holguras.', cell))
        }
        if (cell.width - 2 * config.panelJointClearance - 2 * config.drawerPanelThickness < DEGENERATE_MIN_SIZE) {
          issues.push(makeIssue('drawer-width-too-narrow', 'El espesor de los laterales no deja espacio útil en el cajón.', cell))
        }
        if (drawerDepthBounds(cell, config).sideLength < DEGENERATE_MIN_SIZE) {
          issues.push(makeIssue('drawer-depth-too-shallow', 'La caja del cajón queda sin profundidad suficiente al descontar la reserva para las correderas.', cell))
        }
      }
    }
  }
  return issues
}

export function validateFurnitureDocIssues(furnitureDoc: FurnitureDoc): CompiledAssemblyIssue[] {
  const config = { ...furnitureDoc.config, ...inheritedThicknesses(furnitureDoc.config) }
  const columns = furnitureDoc.columns
  if (columns.length === 0) return []
  const totalWidth = columns.reduce((sum, column) => sum + column.width, 0)
  if (!(totalWidth > 0)) return []
  const construction = normalizeConstruction(furnitureDoc.construction)
  return validateCompiledCells(columns, buildCellGrid(columns, config, construction), config, construction)
}
