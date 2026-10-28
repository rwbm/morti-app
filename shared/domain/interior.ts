import type { FurnitureConfig, FurnitureModule } from './types'

export const INTERIOR_SHELF_COUNT_MAX = 32

export function normalizeShelfCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(INTERIOR_SHELF_COUNT_MAX, Math.round(value)))
    : 0
}

export function interiorShelfCount(module: FurnitureModule): number {
  return module.type === 'drawer' ? 0 : normalizeShelfCount(module.interior?.shelfCount)
}

/** Free height in each opening after installing evenly spaced shelves. */
export function interiorOpeningHeight(module: FurnitureModule, config: FurnitureConfig, usableHeight?: number): number {
  const count = interiorShelfCount(module)
  const height = usableHeight ?? module.height - config.panelThickness - 2 * config.panelJointClearance
  return (height - count * config.panelThickness) / (count + 1)
}
