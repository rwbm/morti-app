import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import * as Y from 'yjs'
import { compileAssembly } from '../shared/domain/assembly'
import { resolveFurnitureDimensions } from '../shared/domain/dimensions'
import { DEFAULT_FURNITURE_CONFIG } from '../shared/domain/defaults'
import { defaultConstruction } from '../shared/domain/construction'
import { DESIGN_SCHEMA_VERSION, type FurnitureDoc, type FurnitureConstruction } from '../shared/domain/types'
import { ensureInitialized, readFurnitureDoc, replaceFurnitureDoc, setExteriorDimensions, setConfigValue, updateConstruction, getFurnitureMap, insertColumn, setModuleHeight } from '../shared/yjs/doc'
import { exportDoc, importDocFromBlob } from '../shared/yjs/morti-format'
import { getProjectFingerprint } from '../shared/domain/fingerprint'
import { normalizeAiFurnitureCurrentDoc } from '../shared/domain/ai-furniture'

function furniture(): FurnitureDoc {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION, lastAppliedMigrationId: null,
    config: { ...DEFAULT_FURNITURE_CONFIG },
    columns: [{ width: 0.8, modules: [{ id: 'ropero', type: 'doors', height: 2, interior: { shelfCount: 4 } }] }],
    construction: defaultConstruction(), exterior: { width: 0.8, height: 2, depth: 0.45 },
  }
}

// Verificación independiente con las rotaciones reales que usa Three.js.
function physicalBounds(doc: FurnitureDoc) {
  const compiled = compileAssembly(doc)
  const bounds = new THREE.Box3()
  for (const panel of compiled.panels) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(panel.width, panel.height, panel.thickness))
    mesh.position.fromArray(panel.position)
    mesh.rotation.set(...panel.rotation)
    mesh.updateMatrixWorld()
    bounds.expandByObject(mesh)
    mesh.geometry.dispose()
  }
  return { bounds, size: bounds.getSize(new THREE.Vector3()), compiled }
}

function expectTarget(doc: FurnitureDoc) {
  const { bounds, size, compiled } = physicalBounds(doc)
  expect(size.x).toBeCloseTo(doc.exterior!.width, 5)
  expect(size.y).toBeCloseTo(doc.exterior!.height, 5)
  expect(size.z).toBeCloseTo(doc.exterior!.depth, 5)
  expect(bounds.min.y).toBeCloseTo(0, 6)
  expect(compiled.issues.filter(i => i.severity === 'error')).toEqual([])
}

describe('Medidas exteriores físicas', () => {
  it.each(['inset', 'overlay', 'cap'] as const)('mantiene 800 × 2000 × 450 mm con tapa %s y cambios de espesores y patas', (topMode) => {
    const doc = furniture()
    doc.construction!.topMode = topMode
    doc.construction!.topOverhang = topMode === 'inset' ? 0 : 0.03
    expectTarget(doc)
    doc.config.panelThickness = 0.025
    doc.config.doorThickness = 0.035
    doc.config.backPanelThickness = 0.006
    doc.construction!.legs.enabled = true
    doc.construction!.legs.height = 0.15
    expectTarget(doc)
  })

  it.each(['leftSide', 'rightSide', 'top', 'back'] as const)('conserva el tamaño al quitar %s', (key) => {
    const doc = furniture()
    doc.construction![key] = false
    expectTarget(doc)
  })

  it('reparte proporcionalmente varias columnas y módulos sin cambiar su identidad', () => {
    const doc = furniture()
    doc.columns = [
      { width: 0.4, modules: [{ id: 'a', type: 'shelf', height: 0.6 }, { id: 'b', type: 'doors', height: 1.4 }] },
      { width: 0.8, modules: [{ id: 'c', type: 'shelf', height: 2 }] },
    ]
    doc.exterior!.width = 1.5
    const resolved = resolveFurnitureDimensions(doc).doc
    expect(resolved.columns[1].width / resolved.columns[0].width).toBeCloseTo(2, 6)
    expect(resolved.columns[0].modules[1].height / resolved.columns[0].modules[0].height).toBeCloseTo(1.4 / 0.6, 6)
    expect(resolved.columns.flatMap(c => c.modules.map(m => m.id))).toEqual(['a', 'b', 'c'])
    expectTarget(doc)
    expectTarget(resolved)
  })

  it('avisa cuando el alto exterior no alcanza para las patas', () => {
    const doc = furniture()
    doc.exterior!.height = 0.05
    doc.construction!.legs.enabled = true
    doc.construction!.legs.height = 0.2
    const result = compileAssembly(doc)
    expect(result.issues.some(i => i.code === 'exterior-unreachable-height')).toBe(true)
    expect(result.panels.every(p => [...p.position, p.width, p.height, p.thickness].every(Number.isFinite))).toBe(true)
  })

  it('respeta los proyectos nominales anteriores sin convertirlos automáticamente', () => {
    const doc = furniture()
    delete doc.exterior
    const { size } = physicalBounds(doc)
    expect(size.x).toBeCloseTo(0.818, 6)
    expect(size.y).toBeCloseTo(2.04, 6)
    expect(size.z).toBeCloseTo(0.46, 6)
  })
})

describe('Tapa exterior y sobretapa', () => {
  it.each(['overlay', 'cap'] as const)('la cubierta %s cubre los laterales y apoya sobre ellos', (topMode) => {
    const doc = furniture()
    delete doc.exterior
    doc.construction!.topMode = topMode
    doc.construction!.topOverhang = 0.03
    const result = compileAssembly(doc)
    const top = result.panels.find(p => p.key === `top:${topMode}`)!
    const sides = result.panels.filter(p => p.role === 'vertical-side')
    expect(top.role).toBe('top-panel')
    for (const side of sides) {
      expect(top.width / 2).toBeGreaterThan(Math.abs(side.position[0]) + side.thickness / 2)
      expect(top.position[1] - top.thickness / 2).toBeCloseTo(side.position[1] + side.height / 2, 6)
    }
    expect(result.panels.some(p => p.key === 'horizontal:column:0:boundary:1')).toBe(topMode === 'cap')
  })

  it('la tapa continua no duplica paneles ni ranuras entre columnas', () => {
    const doc = furniture()
    delete doc.exterior
    doc.construction!.topMode = 'overlay'
    doc.columns.push({ width: 0.6, modules: [{ id: 'otro', type: 'doors', height: 2 }] })
    const result = compileAssembly(doc)
    expect(result.panels.filter(p => p.role === 'top-panel')).toHaveLength(1)
    const grooves = result.operations.filter(op => op.targetPanelKey === 'top:overlay')
    expect(grooves).toHaveLength(2)
    expect(grooves[0].center!.x).not.toBe(grooves[1].center!.x)
    expect(grooves.every(op => op.length! < 1)).toBe(true)
  })
})

describe('Persistencia del tamaño exterior', () => {
  it('recalcula en una sola transacción, permite deshacer y conserva el tamaño al importar', async () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    const original = furniture()
    delete original.exterior
    replaceFurnitureDoc(doc, original)
    const undo = new Y.UndoManager(getFurnitureMap(doc), { trackedOrigins: new Set(['setExteriorDimensions', 'setConfigValue', 'updateConstruction']), captureTimeout: 0 })
    setExteriorDimensions(doc, { width: 0.8, height: 2, depth: 0.45 })
    setConfigValue(doc, 'panelThickness', 0.025)
    updateConstruction(doc, { legs: { enabled: true, height: 0.15 }, topMode: 'cap', topOverhang: 0.02 })
    expectTarget(readFurnitureDoc(doc))
    undo.undo()
    expect(readFurnitureDoc(doc).construction!.topMode).toBe('inset')
    expectTarget(readFurnitureDoc(doc))
    undo.redo()
    const imported = await importDocFromBlob(exportDoc(doc))
    expect(readFurnitureDoc(imported).exterior).toEqual({ width: 0.8, height: 2, depth: 0.45 })
    expectTarget(readFurnitureDoc(imported))
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))
    ensureInitialized(replica)
    expectTarget(readFurnitureDoc(replica))
    undo.destroy(); imported.destroy(); replica.destroy(); doc.destroy()
  })

  it('mantiene la envolvente al agregar columnas y editar el reparto', () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, furniture())
    insertColumn(doc, 1, 0.45)
    setModuleHeight(doc, 1, 0, 1.5)
    expectTarget(readFurnitureDoc(doc))
    doc.destroy()
  })

  it('al volver a nominal conserva las piezas y el tamaño actuales', () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, furniture())
    const before = physicalBounds(readFurnitureDoc(doc)).size
    setExteriorDimensions(doc, null)
    expect(readFurnitureDoc(doc).exterior).toBeUndefined()
    const after = physicalBounds(readFurnitureDoc(doc)).size
    expect(after.distanceTo(before)).toBeLessThan(0.00001)
    doc.destroy()
  })

  it('incluye el tamaño fijado en la sincronización y en el contexto de IA', () => {
    const doc = furniture()
    const hash = getProjectFingerprint(doc)
    expect(normalizeAiFurnitureCurrentDoc(doc).exterior).toEqual(doc.exterior)
    doc.exterior!.width = 1
    expect(getProjectFingerprint(doc)).not.toBe(hash)
  })

  it('combina cambios simultáneos de ancho y alto sin sobrescribir el otro eje', () => {
    const first = new Y.Doc()
    ensureInitialized(first)
    replaceFurnitureDoc(first, furniture())
    const second = new Y.Doc()
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    setExteriorDimensions(first, { width: 1, height: 2, depth: 0.45 })
    setExteriorDimensions(second, { width: 0.8, height: 2.2, depth: 0.45 })
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second))
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    expect(readFurnitureDoc(first).exterior).toEqual({ width: 1, height: 2.2, depth: 0.45 })
    expect(readFurnitureDoc(second).exterior).toEqual(readFurnitureDoc(first).exterior)
    expectTarget(readFurnitureDoc(first))
    expectTarget(readFurnitureDoc(second))
    first.destroy()
    second.destroy()
  })
})
