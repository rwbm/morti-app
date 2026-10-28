import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { compileAssembly } from '../shared/domain/assembly'
import { DEFAULT_FURNITURE_CONFIG } from '../shared/domain/defaults'
import { NEW_THICKNESS_KEYS } from '../shared/domain/thickness'
import { DESIGN_SCHEMA_VERSION, type FurnitureDoc } from '../shared/domain/types'
import { ensureInitialized, getFurnitureMap, readFurnitureDoc, replaceFurnitureDoc, setConfigValue } from '../shared/yjs/doc'
import { exportDoc, importDocFromBlob } from '../shared/yjs/morti-format'
import { normalizeAiFurnitureCurrentDoc } from '../shared/domain/ai-furniture'

function fixture(): FurnitureDoc {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION, lastAppliedMigrationId: null,
    config: { ...DEFAULT_FURNITURE_CONFIG },
    columns: [{ width: 0.8, modules: [
      { id: 'cajones', type: 'drawer', height: 0.6, drawerCount: 3 },
      { id: 'puertas', type: 'doors', height: 1.4, interior: { shelfCount: 3 } },
    ] }],
  }
}

describe('Espesores por grupo', () => {
  it('asigna espesores distintos a las seis familias de piezas', () => {
    const doc = fixture()
    Object.assign(doc.config, { panelThickness: 0.025, doorThickness: 0.022, backPanelThickness: 0.006, drawerFrontThickness: 0.019, drawerPanelThickness: 0.015, drawerBottomThickness: 0.009 })
    const result = compileAssembly(doc)
    expect(result.issues).toEqual([])
    const expected = { 'vertical-side': 0.025, 'horizontal-deck': 0.025, 'door-front': 0.022, 'back-panel': 0.006, 'drawer-front': 0.019, 'drawer-side': 0.015, 'drawer-back': 0.015, 'drawer-bottom': 0.009 }
    for (const p of result.panels) expect(p.thickness).toBeCloseTo(expected[p.role as keyof typeof expected], 6)
    expect(result.operations.filter(op => op.targetPanelKey.startsWith('drawer-') && op.operationType === 'rail-cut').every(op => op.width === 0.01)).toBe(true)
    expect(result.operations.filter(op => op.targetPanelKey.startsWith('vertical:')).every(op => op.width === 0.007)).toBe(true)
  })

  it('cambiar solo el fondo del mueble no altera los espesores del cajón', () => {
    const doc = fixture()
    doc.config.backPanelThickness = 0.006
    const result = compileAssembly(doc)
    expect(result.panels.filter(p => p.role === 'back-panel').every(p => p.thickness === 0.006)).toBe(true)
    expect(result.panels.filter(p => p.role === 'drawer-bottom').every(p => p.thickness === 0.02)).toBe(true)
  })

  it('mantiene los frentes cerrados en el mismo plano y los estantes detrás de puertas gruesas', () => {
    const doc = fixture()
    doc.config.doorThickness = 0.035
    doc.config.drawerFrontThickness = 0.012
    const result = compileAssembly(doc)
    for (const p of result.panels.filter(p => p.role === 'door-front' || p.role === 'drawer-front')) {
      expect(p.position[2] + p.thickness / 2).toBeCloseTo(doc.config.depth / 2, 6)
    }
    const door = result.panels.find(p => p.role === 'door-front')!
    for (const shelf of result.panels.filter(p => p.key.startsWith('interior-shelf:'))) {
      expect(shelf.position[2] + shelf.height / 2).toBeLessThan(door.position[2] - door.thickness / 2)
    }
  })

  it.each([[0.012, 0.022], [0.025, 0.008]])('encastra el fondo con laterales de %s m y frente de %s m', (sideThickness, frontThickness) => {
    const doc = fixture()
    doc.config.drawerPanelThickness = sideThickness
    doc.config.drawerFrontThickness = frontThickness
    doc.config.drawerBottomThickness = 0.006
    const result = compileAssembly(doc)
    const byKey = new Map(result.panels.map(p => [p.key, p]))
    const reserve = Math.min(sideThickness, frontThickness) / 4
    for (let i = 0; i < 3; i++) {
      const bottom = byKey.get(`drawer-bottom:cajones:${i}`)!
      const front = byKey.get(`drawer-front:cajones:${i}`)!
      const back = byKey.get(`drawer-back:cajones:${i}`)!
      const left = byKey.get(`drawer-side:cajones:${i}:left`)!
      const right = byKey.get(`drawer-side:cajones:${i}:right`)!
      expect(bottom.position[2] + bottom.height / 2 - (front.position[2] - front.thickness / 2)).toBeCloseTo(reserve, 6)
      expect(back.position[2] + back.thickness / 2 - (bottom.position[2] - bottom.height / 2)).toBeCloseTo(reserve, 6)
      expect(left.position[0] + left.thickness / 2 - (bottom.position[0] - bottom.width / 2)).toBeCloseTo(reserve, 6)
      expect(bottom.position[0] + bottom.width / 2 - (right.position[0] - right.thickness / 2)).toBeCloseTo(reserve, 6)
    }
    expect(result.issues).toEqual([])
  })

  it('avisa si los espesores dejan al cajón sin ancho o profundidad útil', () => {
    const doc = fixture()
    doc.columns[0].width = 0.12
    doc.config.depth = 0.1
    doc.config.drawerPanelThickness = 0.06
    doc.config.drawerFrontThickness = 0.06
    expect(compileAssembly(doc).issues.map(i => i.code)).toEqual(expect.arrayContaining(['drawer-width-too-narrow', 'drawer-depth-too-shallow']))
  })
})

describe('Compatibilidad y persistencia de espesores', () => {
  it('separa los espesores antiguos antes de modificar el cuerpo aunque el documento siga abierto', () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    const config = getFurnitureMap(doc).get('config') as Y.Map<unknown>
    config.set('panelThickness', 0.025)
    for (const key of NEW_THICKNESS_KEYS) config.delete(key)
    setConfigValue(doc, 'panelThickness', 0.018)
    expect(readFurnitureDoc(doc).config).toMatchObject({ panelThickness: 0.018, doorThickness: 0.025, drawerPanelThickness: 0.025 })
    doc.destroy()
  })

  it('hereda espesores personalizados al importar un documento anterior y no vuelve a vincularlos', () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, fixture())
    const config = getFurnitureMap(doc).get('config') as Y.Map<unknown>
    config.set('panelThickness', 0.025)
    config.set('backPanelThickness', 0.006)
    for (const key of NEW_THICKNESS_KEYS) config.delete(key)
    ensureInitialized(doc)
    expect(readFurnitureDoc(doc).config).toMatchObject({ doorThickness: 0.025, drawerFrontThickness: 0.025, drawerPanelThickness: 0.025, drawerBottomThickness: 0.006 })
    config.set('panelThickness', 0.018)
    config.set('backPanelThickness', 0.009)
    ensureInitialized(doc)
    expect(readFurnitureDoc(doc).config).toMatchObject({ doorThickness: 0.025, drawerPanelThickness: 0.025, drawerBottomThickness: 0.006 })
    doc.destroy()
  })

  it('conserva los espesores al deshacer/rehacer, exportar/importar y normalizar para IA', async () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, fixture())
    const undo = new Y.UndoManager(getFurnitureMap(doc), { trackedOrigins: new Set(['setConfigValue']) })
    setConfigValue(doc, 'drawerBottomThickness', 0.006)
    undo.undo()
    expect(readFurnitureDoc(doc).config.drawerBottomThickness).toBe(0.02)
    undo.redo()
    const imported = await importDocFromBlob(exportDoc(doc))
    expect(readFurnitureDoc(imported)).toEqual(readFurnitureDoc(doc))
    expect(normalizeAiFurnitureCurrentDoc(readFurnitureDoc(doc)).config.drawerBottomThickness).toBe(0.006)
    undo.destroy()
    imported.destroy()
    doc.destroy()
  })
})
