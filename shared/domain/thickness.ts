import type { FurnitureConfig, FurnitureModule } from './types'

export const THICKNESS_FIELDS = [
  { key: 'panelThickness', label: 'Cuerpo y estantes' },
  { key: 'doorThickness', label: 'Puertas' },
  { key: 'backPanelThickness', label: 'Fondo del mueble' },
  { key: 'drawerFrontThickness', label: 'Frentes de cajón' },
  { key: 'drawerPanelThickness', label: 'Laterales y traseras de cajón' },
  { key: 'drawerBottomThickness', label: 'Fondos de cajón' },
] as const
export type ThicknessKey = typeof THICKNESS_FIELDS[number]['key']
export const NEW_THICKNESS_KEYS = ['doorThickness', 'drawerFrontThickness', 'drawerPanelThickness', 'drawerBottomThickness'] as const

/** Heredar las medidas originales, no reemplazarlas por valores nuevos. */
export function inheritedThicknesses(source: Partial<Record<ThicknessKey, unknown>>) {
  const valid = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const structure = valid(source.panelThickness, 0.018)
  return {
    doorThickness: valid(source.doorThickness, structure),
    drawerFrontThickness: valid(source.drawerFrontThickness, structure),
    drawerPanelThickness: valid(source.drawerPanelThickness, structure),
    drawerBottomThickness: valid(source.drawerBottomThickness, valid(source.backPanelThickness, 0.02)),
  }
}

export function moduleFrontThickness(module: FurnitureModule, config: FurnitureConfig): number {
  if (module.type === 'drawer') return config.drawerFrontThickness ?? config.panelThickness
  if (module.type !== 'shelf') return config.doorThickness ?? config.panelThickness
  return config.panelThickness
}

export function drawerGrooveDepth(config: FurnitureConfig): number {
  return Math.min(config.drawerPanelThickness, config.drawerFrontThickness) / 4
}

export function drawerDepthBounds(cell: { depth: number, zMax: number, frontZ: number }, config: FurnitureConfig) {
  const backOuter = cell.zMax - (cell.depth - config.drawerSlidesReserve) + config.panelJointClearance
  const backInner = backOuter + config.drawerPanelThickness
  const frontInner = cell.frontZ - config.drawerFrontThickness / 2
  const sideRear = backInner + config.panelJointClearance
  const sideFront = frontInner - config.panelJointClearance
  return { backOuter, backInner, frontInner, sideLength: sideFront - sideRear, centerZ: (sideFront + sideRear) / 2 }
}
