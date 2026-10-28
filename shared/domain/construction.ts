import type { FurnitureConstruction, FurnitureConfig } from './types'

export const CONSTRUCTION_PANEL_KEYS = ['leftSide', 'rightSide', 'top', 'bottom', 'back'] as const
export const LEG_METRIC_LIMITS = {
  height: { min: 0.04, max: 0.5 },
  width: { min: 0.02, max: 0.12 },
  inset: { min: 0, max: 0.2 },
} as const

export function defaultConstruction(): FurnitureConstruction {
  return {
    leftSide: true, rightSide: true, top: true, bottom: true, back: true,
    topMode: 'inset', topOverhang: 0,
    legs: { enabled: false, height: 0.1, width: 0.04, inset: 0.03 },
  }
}

export function normalizeConstruction(value: unknown): FurnitureConstruction {
  const result = defaultConstruction()
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  for (const key of CONSTRUCTION_PANEL_KEYS) {
    if (typeof source[key] === 'boolean') result[key] = source[key]
  }
  if (source.topMode === 'overlay' || source.topMode === 'cap') result.topMode = source.topMode
  if (typeof source.topOverhang === 'number' && Number.isFinite(source.topOverhang)) {
    result.topOverhang = Math.round(Math.max(0, Math.min(0.2, source.topOverhang)) * 1000) / 1000
  }
  const legs = source.legs && typeof source.legs === 'object' ? source.legs as Record<string, unknown> : {}
  if (typeof legs.enabled === 'boolean') result.legs.enabled = legs.enabled
  for (const key of ['height', 'width', 'inset'] as const) {
    const raw = legs[key]
    const { min, max } = LEG_METRIC_LIMITS[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      result.legs[key] = Math.round(Math.min(max, Math.max(min, raw)) * 1000) / 1000
    }
  }
  return result
}

/** Existing floors sit slightly above the lower edge of the sides. */
export function floorUnderside(config: FurnitureConfig): number {
  return config.sidePanelOverhang - config.panelThickness / 2
}

export function constructionBodyLift(construction: FurnitureConstruction, config: FurnitureConfig): number {
  return construction.legs.enabled ? Math.max(0, construction.legs.height - floorUnderside(config)) : 0
}

/** Four feet under each column's floor. Inset is measured from the floor edge. */
export function legCenters(columnWidth: number, depth: number, config: FurnitureConfig, construction: FurnitureConstruction): { x: number[], z: number[] } {
  const { width, inset } = construction.legs
  const halfFloorWidth = (columnWidth - config.panelThickness - 2 * config.panelJointClearance) / 2
  const halfFloorDepth = (depth + config.sidePanelOverhang / 2) / 2
  return {
    x: [-halfFloorWidth + inset + width / 2, halfFloorWidth - inset - width / 2],
    z: [-halfFloorDepth + inset + width / 2 + config.sidePanelOverhang / 4, halfFloorDepth - inset - width / 2 + config.sidePanelOverhang / 4],
  }
}
