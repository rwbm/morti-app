import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { compileAssembly } from '../shared/domain/assembly'
import { DEFAULT_FURNITURE_CONFIG } from '../shared/domain/defaults'
import { DESIGN_SCHEMA_VERSION, type FurnitureDoc, type ModuleType } from '../shared/domain/types'
import { ensureInitialized, getFurnitureMap, readFurnitureDoc, replaceFurnitureDoc, setInteriorShelfCount, setModuleType } from '../shared/yjs/doc'
import { exportDoc, importDocFromBlob } from '../shared/yjs/morti-format'
import { normalizeAiFurnitureCurrentDoc, normalizeAiFurnitureDraft } from '../shared/domain/ai-furniture'
import { validateFurnitureDocIssues } from '../shared/domain/assembly-validation'

function furniture(type: ModuleType = 'doors', shelfCount = 4): FurnitureDoc {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    lastAppliedMigrationId: null,
    config: { ...DEFAULT_FURNITURE_CONFIG },
    columns: [{ width: 0.8, modules: [{ id: 'ropero', type, height: 2, interior: { shelfCount } }] }],
  }
}

describe('Interior independiente del frente', () => {
  it.each(['shelf', 'doors', 'left-door', 'right-door'] as const)('genera cuatro estantes con frente %s', (type) => {
    const doc = furniture(type)
    const assembly = compileAssembly(doc)
    const shelves = assembly.panels.filter(panel => panel.key.startsWith('interior-shelf:'))
    expect(assembly.issues).toEqual([])
    expect(shelves).toHaveLength(4)
    expect(new Set(assembly.panels.map(p => p.key)).size).toBe(assembly.panels.length)
    for (const shelf of shelves) {
      expect(shelf.role).toBe('horizontal-deck')
      expect(shelf.sourceModuleId).toBe('ropero')
      expect(shelf.width).toBeCloseTo(0.778, 3)
      expect(shelf.height).toBeGreaterThan(0)
      expect(shelf.position[1]).toBeGreaterThan(0)
      expect(shelf.position[1]).toBeLessThan(2)
      // A closed door sits at z=0.207..0.225; shelves stop behind it.
      expect(shelf.position[2] + shelf.height / 2).toBeLessThan(0.207)
    }
    const gaps = shelves.slice(1).map((s, i) => s.position[1] - shelves[i].position[1])
    // Las posiciones derivadas conservan las fracciones de milímetro.
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(0.00101)
    expect(assembly.panels.filter(p => p.role === 'door-front')).toHaveLength(type === 'doors' ? 2 : type === 'shelf' ? 0 : 1)
  })

  it('mantiene los muebles anteriores sin estantes adicionales', () => {
    const doc = furniture()
    delete doc.columns[0].modules[0].interior
    const result = compileAssembly(doc)
    expect(result.panels).toHaveLength(7)
    expect(result.issues).toEqual([])
  })

  it('avisa cuando no queda espacio entre estantes y usa la misma validación en el compilador', () => {
    const doc = furniture('doors', 32)
    doc.columns[0].modules[0].height = 0.3
    const issues = validateFurnitureDocIssues(doc)
    expect(issues.some(i => i.code === 'interior-openings-too-short')).toBe(true)
    expect(compileAssembly(doc).issues).toEqual(issues)
  })

  it('no mezcla estantes y cajas de cajones', () => {
    const doc = furniture('drawer')
    doc.columns[0].modules[0].drawerCount = 8
    expect(compileAssembly(doc).panels.some(p => p.key.startsWith('interior-shelf:'))).toBe(false)
  })
})

describe('Persistencia y compatibilidad', () => {
  it('permite deshacer y rehacer la distribución interior sin tocar el frente', () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, furniture())
    const undo = new Y.UndoManager(getFurnitureMap(doc), { trackedOrigins: new Set(['setInteriorShelfCount']) })
    setInteriorShelfCount(doc, 0, 0, 2)
    undo.undo()
    expect(readFurnitureDoc(doc).columns[0].modules[0].interior?.shelfCount).toBe(4)
    undo.redo()
    expect(readFurnitureDoc(doc).columns[0].modules[0].interior?.shelfCount).toBe(2)
    expect(readFurnitureDoc(doc).columns[0].modules[0].type).toBe('doors')
    undo.destroy()
    doc.destroy()
  })

  it('conserva el interior al cambiar el frente y al exportar/importar .morti', async () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, furniture())
    setModuleType(doc, 0, 0, 'shelf')
    expect(readFurnitureDoc(doc).columns[0].modules[0].interior?.shelfCount).toBe(4)
    setInteriorShelfCount(doc, 0, 0, 3)
    setModuleType(doc, 0, 0, 'left-door')
    const imported = await importDocFromBlob(exportDoc(doc))
    expect(readFurnitureDoc(imported)).toEqual(readFurnitureDoc(doc))
    expect(compileAssembly(readFurnitureDoc(imported)).panels.filter(p => p.key.startsWith('interior-shelf:'))).toHaveLength(3)
    imported.destroy()
    doc.destroy()
  })

  it('sincroniza el interior por Yjs y conserva estantes al pasar temporalmente a cajones', () => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    replaceFurnitureDoc(doc, furniture())
    setModuleType(doc, 0, 0, 'drawer')
    setInteriorShelfCount(doc, 0, 0, 20)
    setModuleType(doc, 0, 0, 'doors')
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))
    ensureInitialized(replica)
    expect(readFurnitureDoc(replica).columns[0].modules[0].interior?.shelfCount).toBe(4)
    replica.destroy()
    doc.destroy()
  })

  it.each([1.2, 2.4])('migra los límites anteriores y respeta valores personalizados (%s)', (limit) => {
    const doc = new Y.Doc()
    ensureInitialized(doc)
    const root = getFurnitureMap(doc)
    const cfg = root.get('config') as Y.Map<unknown>
    cfg.set('maxColumnWidth', limit)
    cfg.set('maxModuleHeight', limit)
    root.set('lastAppliedMigrationId', '1740000001000_legacy_furniture_config_keys')
    ensureInitialized(doc)
    expect(readFurnitureDoc(doc).config.maxModuleHeight).toBe(limit === 1.2 ? 3 : limit)
    expect(readFurnitureDoc(doc).config.maxColumnWidth).toBe(limit === 1.2 ? 3 : limit)
    cfg.set('maxModuleHeight', 1.2)
    ensureInitialized(doc)
    expect(readFurnitureDoc(doc).config.maxModuleHeight).toBe(1.2)
    doc.destroy()
  })

  it('conserva estantes y dimensiones en la normalización para IA', () => {
    const normalized = normalizeAiFurnitureCurrentDoc(furniture())
    expect(normalized.columns[0].modules[0].interior?.shelfCount).toBe(4)
    expect(normalized.columns[0].modules[0].height).toBe(2)
    const draft = normalizeAiFurnitureDraft({ c: [{ w: 2, m: [{ t: 'D', h: 2, sc: 4 }] }] })
    expect(draft.doc.columns[0].width).toBe(2)
    expect(draft.doc.columns[0].modules[0].interior?.shelfCount).toBe(4)
  })
})
