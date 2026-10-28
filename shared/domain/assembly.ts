import * as THREE from 'three'
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg'
import type { CompiledAssembly, CompiledPanel, FurnitureDoc, PanelOperation } from './types'
import { resolveFurnitureDimensions } from './dimensions'

const HOLE_MIN_DIAMETER = 5e-4
const PULL_HOLE_DEPTH_PADDING = 1e-6

export function compileAssembly(doc: FurnitureDoc): CompiledAssembly {
  return resolveFurnitureDimensions(doc).assembly
}

// ---------------------------------------------------------------------------
// Geometry compilation (CSG cache)
// ---------------------------------------------------------------------------

const GEOMETRY_CACHE = new Map<string, THREE.BufferGeometry>()

// Lazy CSG evaluator — created once and re-used. (three-bvh-csg is GPU-free.)
let evaluatorInstance: Evaluator | null = null
function getEvaluator(): Evaluator {
  if (evaluatorInstance) return evaluatorInstance
  evaluatorInstance = new Evaluator()
  evaluatorInstance.useGroups = false
  return evaluatorInstance
}

function panelGeometryCacheKey(panel: CompiledPanel, operations: PanelOperation[]): string {
  // Hash includes role-independent dims + every through-hole on this panel.
  const ops = operations
    .filter(o => o.operationType === 'through-hole' && o.targetPanelKey === panel.key)
    .map(o => `${(o.center?.x ?? o.cx ?? 0).toFixed(6)},${(o.center?.y ?? o.cy ?? 0).toFixed(6)},${(o.diameter ?? 0).toFixed(6)}`)
    .sort()
    .join(';')
  return [
    panel.role,
    panel.width.toFixed(6),
    panel.height.toFixed(6),
    panel.thickness.toFixed(6),
    ops,
  ].join('|')
}

/**
 * Build a panel BufferGeometry. Through-hole operations are subtracted via
 * three-bvh-csg; rail-cuts are not represented in geometry — they are drawn
 * as outline rectangles by RailCutMesh.
 */
export function compilePartGeometry(
  panel: CompiledPanel,
  operations: PanelOperation[],
): THREE.BufferGeometry {
  const key = panelGeometryCacheKey(panel, operations)
  const cached = GEOMETRY_CACHE.get(key)
  if (cached) return cached.clone()

  const w = Math.max(0.001, panel.width)
  const h = Math.max(0.001, panel.height)
  const t = Math.max(0.001, panel.thickness)

  const box = new THREE.BoxGeometry(w, h, t)
  let brushAccum = new Brush(box)
  brushAccum.updateMatrixWorld()

  const evaluator = getEvaluator()
  const holes = operations.filter(
    o =>
      o.operationType === 'through-hole'
      && o.targetPanelKey === panel.key
      && (o.diameter ?? 0) > 0,
  )

  if (holes.length > 0) {
    const cylHeight = t * 1.35 + PULL_HOLE_DEPTH_PADDING * 2
    for (const op of holes) {
      const r = Math.max(HOLE_MIN_DIAMETER / 2, (op.diameter ?? 0) / 2)
      const cyl = new THREE.CylinderGeometry(r, r, cylHeight, 32)
      cyl.rotateX(Math.PI / 2)
      cyl.translate(op.center?.x ?? op.cx ?? 0, op.center?.y ?? op.cy ?? 0, 0)
      const cutBrush = new Brush(cyl)
      cutBrush.updateMatrixWorld()
      brushAccum = evaluator.evaluate(brushAccum, cutBrush, SUBTRACTION) as Brush
      cyl.dispose()
    }
  }

  const result = brushAccum.geometry.clone()
  GEOMETRY_CACHE.set(key, result)
  return result.clone()
}

/** Drop the geometry cache (e.g. on hot reload, or before a full teardown). */
export function clearPanelGeometryCache(): void {
  for (const g of GEOMETRY_CACHE.values()) g.dispose()
  GEOMETRY_CACHE.clear()
}
