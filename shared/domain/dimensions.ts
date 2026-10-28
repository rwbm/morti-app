import type { CompiledAssembly, CompiledPanel, ExteriorDimensions, FurnitureDoc } from './types'
import { compileNominalAssembly } from './assembly-panels'

export function normalizeExteriorDimensions(value: unknown): ExteriorDimensions | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  if (!['width', 'height', 'depth'].every(key => typeof source[key] === 'number' && Number.isFinite(source[key]) && (source[key] as number) > 0)) return undefined
  return { width: source.width as number, height: source.height as number, depth: source.depth as number }
}

/** Límites físicos de las piezas cerradas, sin depender de cámara ni animaciones. */
export function assemblyBounds(panels: CompiledPanel[]) {
  if (!panels.length) return null
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const panel of panels) {
    const size = panel.orientation === 'horizontal-xz'
      ? [panel.width, panel.thickness, panel.height]
      : panel.orientation === 'vertical-yz'
        ? [panel.thickness, panel.height, panel.width]
        : [panel.width, panel.height, panel.thickness]
    if (![...size, ...panel.position].every(Number.isFinite)) return null
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], panel.position[axis] - size[axis] / 2)
      max[axis] = Math.max(max[axis], panel.position[axis] + size[axis] / 2)
    }
  }
  return { min, max, width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] }
}

/**
 * Resuelve tres parámetros nominales sin escalar espesores, patas ni holguras.
 * Las piezas actuales son afines a esos parámetros; se mide su respuesta real
 * para incluir tapas, vuelos y laterales opcionales. No se generan mallas CSG.
 */
export function resolveFurnitureDimensions(source: FurnitureDoc): { doc: FurnitureDoc, assembly: CompiledAssembly } {
  const exterior = normalizeExteriorDimensions(source.exterior)
  if (!exterior) return { doc: source, assembly: compileNominalAssembly(source) }
  const initialWidth = source.columns.reduce((sum, column) => sum + column.width, 0)
  const initialHeight = Math.max(0, ...source.columns.map(column => column.modules.reduce((sum, module) => sum + module.height, 0)))
  if (!(initialWidth > 0 && initialHeight > 0)) {
    return { doc: source, assembly: { panels: [], operations: [], issues: [{ code: 'exterior-empty', severity: 'error', message: 'Agregá al menos una columna con módulos para calcular las medidas exteriores.' }] } }
  }

  let parameters = [initialWidth, initialHeight, source.config.depth]
  const target = [exterior.width, exterior.height, exterior.depth]
  const names = ['width', 'height', 'depth'] as const
  const labels = ['ancho', 'alto', 'profundidad']
  const tolerance = 0.00001 // 0,01 mm: por encima de la precisión del compilador.
  const makeDoc = (values: number[]): FurnitureDoc => ({
    ...source, exterior,
    config: { ...source.config, depth: values[2] },
    columns: source.columns.map(column => ({
      ...column, width: column.width * values[0] / initialWidth,
      modules: column.modules.map(module => ({ ...module, height: module.height * values[1] / initialHeight })),
    })),
  })
  const measure = (values: number[]) => assemblyBounds(compileNominalAssembly(makeDoc(values), false).panels)

  for (let iteration = 0; iteration < 6; iteration++) {
    let converged = true
    let bounds = measure(parameters)
    for (let axis = 0; axis < 3; axis++) {
      if (!bounds) break
      const error = target[axis] - bounds[names[axis]]
      if (Math.abs(error) <= tolerance) continue
      converged = false
      const probe = [...parameters]
      probe[axis] += 0.01
      const measured = measure(probe)
      const slope = measured ? (measured[names[axis]] - bounds[names[axis]]) / 0.01 : 0
      if (slope > 0.00001 && Number.isFinite(slope)) {
        parameters[axis] = Math.max(0.001, parameters[axis] + error / slope)
        bounds = measure(parameters)
      }
    }
    if (converged) break
  }
  const doc = makeDoc(parameters)
  const assembly = compileNominalAssembly(doc)
  const bounds = assemblyBounds(assembly.panels)
  if (!bounds) {
    assembly.issues.push({ code: 'exterior-empty', severity: 'error', message: 'No hay piezas con las que definir el tamaño exterior. Activá alguna pieza de la estructura.' })
    return { doc, assembly }
  }
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(bounds[names[axis]] - target[axis]) > tolerance) {
      assembly.issues.push({ code: `exterior-unreachable-${names[axis]}`, severity: 'error', message: `No se puede obtener ese ${labels[axis]} exterior con la estructura actual. Revisá espesores, patas y vuelos.` })
    }
  }
  // El modo exterior apoya el conjunto en el suelo y centra su envolvente.
  const offset = [(bounds.min[0] + bounds.max[0]) / 2, bounds.min[1], (bounds.min[2] + bounds.max[2]) / 2]
  assembly.panels = assembly.panels.map(panel => ({ ...panel, position: panel.position.map((value, axis) => value - offset[axis]) as [number, number, number] }))
  return { doc, assembly }
}
