import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { compileAssembly } from '../shared/domain/assembly'
import { constructionBodyLift, defaultConstruction, normalizeConstruction } from '../shared/domain/construction'
import { DEFAULT_FURNITURE_CONFIG } from '../shared/domain/defaults'
import { DESIGN_SCHEMA_VERSION, type FurnitureDoc } from '../shared/domain/types'
import { ensureInitialized, getFurnitureMap, readFurnitureDoc, replaceFurnitureDoc, updateConstruction } from '../shared/yjs/doc'
import { exportDoc, importDocFromBlob } from '../shared/yjs/morti-format'
import { getProjectFingerprint } from '../shared/domain/fingerprint'
import { normalizeAiFurnitureCurrentDoc } from '../shared/domain/ai-furniture'
import { panelRoleLabel, panelRoleCode, panelCutlistSignature } from '../shared/domain/cutlist'

function furniture(): FurnitureDoc {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    lastAppliedMigrationId: null,
    config: { ...DEFAULT_FURNITURE_CONFIG },
    columns: [{ width: 0.8, modules: [
      { id: 'cajones', type: 'drawer', drawerCount: 3, height: 0.6 },
      { id: 'puertas', type: 'doors', height: 1.4, interior: { shelfCount: 3 } },
    ] }],
    construction: defaultConstruction(),
  }
}

describe('Piezas exteriores independientes', () => {
  it('mantiene exactamente el mueble anterior al abrir un documento sin estructura', () => {
    const explicit = furniture()
    const old = furniture()
    delete old.construction
    expect(compileAssembly(old)).toEqual(compileAssembly(explicit))
  })

  it.each([
    ['leftSide', 'vertical:boundary:0'],
    ['rightSide', 'vertical:boundary:1'],
    ['bottom', 'horizontal:column:0:boundary:0'],
    ['top', 'horizontal:column:0:boundary:2'],
  ] as const)('quita %s conservando el resto de las piezas', (part, key) => {
    const doc = furniture()
    const original = compileAssembly(doc)
    doc.construction![part] = false
    const changed = compileAssembly(doc)
    expect(changed.panels.map(p => p.key)).toEqual(original.panels.filter(p => p.key !== key).map(p => p.key))
    expect(changed.panels.find(p => p.key === 'horizontal:column:0:boundary:1')).toBeDefined()
    expect(changed.operations.some(op => op.targetPanelKey === key)).toBe(false)
    const keys = new Set(changed.panels.map(p => p.key))
    expect(changed.operations.every(op => keys.has(op.targetPanelKey))).toBe(true)
  })

  it('quita el fondo y sus ranuras, pero conserva las ranuras de los cajones', () => {
    const doc = furniture()
    const original = compileAssembly(doc)
    doc.construction!.back = false
    const result = compileAssembly(doc)
    expect(result.panels.some(p => p.role === 'back-panel')).toBe(false)
    expect(result.panels.filter(p => p.role === 'drawer-back')).toHaveLength(3)
    const originalShelf = original.panels.find(p => p.key.startsWith('interior-shelf:'))!
    const shelf = result.panels.find(p => p.key === originalShelf.key)!
    expect(shelf.height).toBeGreaterThan(originalShelf.height)
    // Remaining rail cuts belong to the drawer bottoms, not the cabinet back.
    expect(result.operations.filter(op => op.operationType === 'rail-cut').every(op => op.targetPanelKey.startsWith('drawer-'))).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('conserva las divisiones verticales al quitar ambos laterales exteriores', () => {
    const doc = furniture()
    doc.columns.push({ width: 0.6, modules: [{ id: 'abierto', type: 'shelf', height: 1 }] })
    doc.construction!.leftSide = false
    doc.construction!.rightSide = false
    const vertical = compileAssembly(doc).panels.filter(p => p.role === 'vertical-side')
    expect(vertical.map(p => p.key)).toEqual(['vertical:boundary:1'])
  })
})

describe('Patas', () => {
  it('genera cuatro patas por columna que tocan el piso y el suelo, sin cambiar el tamaño del cuerpo', () => {
    const doc = furniture()
    const original = compileAssembly(doc)
    doc.construction!.legs.enabled = true
    doc.construction!.legs.height = 0.15
    const result = compileAssembly(doc)
    const legs = result.panels.filter(p => p.role === 'leg')
    expect(legs).toHaveLength(4)
    expect(result.issues).toEqual([])
    for (const leg of legs) {
      expect(leg.position[1] - leg.height / 2).toBeCloseTo(0, 3)
      expect(leg.position[1] + leg.height / 2).toBeCloseTo(0.15, 3)
      expect(leg.width).toBe(0.04)
      expect(leg.thickness).toBe(0.04)
      expect(panelRoleLabel(leg.role)).toBe('Pata')
      expect(panelRoleCode(leg.role)).toBe('P')
      expect(panelCutlistSignature(leg, result.operations)).toBe(panelCutlistSignature(legs[0], result.operations))
    }
    const floor = result.panels.find(p => p.key === 'horizontal:column:0:boundary:0')!
    expect(floor.position[1] - floor.thickness / 2).toBeCloseTo(0.15, 3)
    const lift = constructionBodyLift(doc.construction!, doc.config)
    for (const panel of original.panels) {
      const next = result.panels.find(p => p.key === panel.key)!
      expect([next.width, next.height, next.thickness, next.rotation]).toEqual([panel.width, panel.height, panel.thickness, panel.rotation])
      expect(next.position[1] - panel.position[1]).toBeCloseTo(lift, 3)
      expect(next.position[0]).toBe(panel.position[0])
      expect(next.position[2]).toBe(panel.position[2])
    }
    doc.construction!.legs.enabled = false
    expect(compileAssembly(doc)).toEqual(original)
  })

  it('ubica patas bajo cada columna con claves distintas y dentro del piso', () => {
    const doc = furniture()
    doc.columns.push({ width: 0.6, modules: [{ id: 'segundo', type: 'shelf', height: 1 }] })
    doc.construction!.legs.enabled = true
    const result = compileAssembly(doc)
    const legs = result.panels.filter(p => p.role === 'leg')
    expect(legs).toHaveLength(8)
    expect(new Set(legs.map(p => p.key)).size).toBe(8)
    expect(result.issues).toEqual([])
    for (let ci = 0; ci < doc.columns.length; ci++) {
      const floor = result.panels.find(p => p.key === `horizontal:column:${ci}:boundary:0`)!
      for (const leg of legs.filter(p => p.key.startsWith(`leg:column:${ci}:`))) {
        expect(Math.abs(leg.position[0] - floor.position[0]) + leg.width / 2).toBeLessThan(floor.width / 2)
        expect(Math.abs(leg.position[2] - floor.position[2]) + leg.thickness / 2).toBeLessThan(floor.height / 2)
      }
    }
  })

  it('avisa si faltan piso, espacio para patas o altura bajo el cuerpo', () => {
    const doc = furniture()
    doc.construction!.legs = { enabled: true, height: 0.04, width: 0.12, inset: 0.2 }
    doc.construction!.bottom = false
    doc.config.sidePanelOverhang = 0.1
    expect(compileAssembly(doc).issues.map(i => i.code)).toEqual(expect.arrayContaining(['legs-require-bottom', 'legs-do-not-fit', 'legs-too-short']))
  })
})

describe('Guardado de la estructura', () => {
  it('conserva la estructura al exportar/importar y permite deshacer/rehacer', async () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, furniture())
    const undo = new Y.UndoManager(getFurnitureMap(doc), { trackedOrigins: new Set(['updateConstruction']) })
    updateConstruction(doc, { back: false, top: false, legs: { enabled: true, height: 0.18 } })
    const changed = readFurnitureDoc(doc)
    undo.undo()
    expect(readFurnitureDoc(doc).construction).toEqual(defaultConstruction())
    undo.redo()
    expect(readFurnitureDoc(doc)).toEqual(changed)
    const imported = await importDocFromBlob(exportDoc(doc))
    expect(readFurnitureDoc(imported)).toEqual(changed)
    expect(compileAssembly(readFurnitureDoc(imported))).toEqual(compileAssembly(changed))
    undo.destroy()
    imported.destroy()
    doc.destroy()
  })

  it('combina cambios simultáneos en distintas partes por Yjs', () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, furniture())
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))
    updateConstruction(doc, { leftSide: false, legs: { height: 0.2 } })
    updateConstruction(replica, { back: false, legs: { enabled: true } })
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(replica))
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))
    expect(readFurnitureDoc(doc)).toEqual(readFurnitureDoc(replica))
    expect(readFurnitureDoc(doc).construction).toMatchObject({ leftSide: false, back: false, legs: { enabled: true, height: 0.2 } })
    replica.destroy()
    doc.destroy()
  })

  it('detecta los cambios de estructura para la sincronización y los conserva al normalizar IA', () => {
    const doc = furniture()
    const before = getProjectFingerprint(doc)
    doc.construction!.back = false
    doc.construction!.legs.enabled = true
    expect(getProjectFingerprint(doc)).not.toBe(before)
    expect(normalizeAiFurnitureCurrentDoc(doc).construction).toEqual(doc.construction)
    delete doc.construction
    expect(getProjectFingerprint(doc)).toBe(before)
  })

  it('normaliza datos inválidos antes de generar geometría', () => {
    const construction = normalizeConstruction({ back: 'false', legs: { enabled: true, height: NaN, width: -5, inset: Infinity } })
    expect(construction.back).toBe(true)
    expect(construction.legs).toEqual({ enabled: true, height: 0.1, width: 0.02, inset: 0.03 })
  })
})
