import { describe, expect, it } from 'vitest'
import { compileAssembly } from '../shared/domain/assembly'
import { groupCutlistPanels, groupCutlistOperations, panelCutlistSignature, panelCutlistOrientation } from '../shared/domain/cutlist'
import { formatMillimetres } from '../shared/domain/units'
import { DEFAULT_FURNITURE_CONFIG } from '../shared/domain/defaults'
import { DESIGN_SCHEMA_VERSION, type FurnitureDoc, type CompiledPanel, type PanelOperation } from '../shared/domain/types'

function wardrobe(): FurnitureDoc {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION, lastAppliedMigrationId: null,
    config: { ...DEFAULT_FURNITURE_CONFIG },
    columns: [{ width: 0.45, modules: [{ id: 'ropero', type: 'doors', height: 2, interior: { shelfCount: 4 } }] }],
  }
}

function panel(key: string): CompiledPanel {
  return { key, role: 'horizontal-deck', width: 0.4, height: 0.3, thickness: 0.018, position: [0, 0, 0], rotation: [0, 0, 0], orientation: 'horizontal-xz', operations: [] }
}

function groove(target: string, rotation = 0): PanelOperation {
  return { id: `ranura:${target}`, targetPanelKey: target, operationType: 'rail-cut', center: { x: 0, y: 0 }, width: 0.006, length: 0.2, depth: 0.0045, rotation, face: 'front', through: false }
}

describe('Unidades del despiece', () => {
  it.each([
    [2, '2000'], [0.45, '450'], [0.018, '18'], [0.0045, '4,5'], [0, '0'], [-0.03, '-30'], [0.000001, '0,001'],
  ])('muestra %s metros como %s milímetros', (metres, expected) => {
    expect(formatMillimetres(metres)).toBe(expected)
  })
  it('no presenta valores ausentes como cero', () => {
    expect(formatMillimetres(null)).toBe('—')
    expect(formatMillimetres(NaN)).toBe('—')
  })
})

describe('Medidas de piezas conocidas', () => {
  it('descuenta espesores y holguras, y distingue la pieza del tamaño nominal del módulo', () => {
    const compiled = compileAssembly(wardrobe())
    const dimensions = (key: string) => {
      const p = compiled.panels.find(p => p.key === key)!
      return [p.width, p.height, p.thickness].map(formatMillimetres)
    }
    expect(dimensions('vertical:boundary:0')).toEqual(['450', '2040', '18'])
    expect(dimensions('horizontal:column:0:boundary:0')).toEqual(['428', '460', '18'])
    expect(dimensions('interior-shelf:ropero:0')).toEqual(['428', '398', '18'])
    expect(dimensions('door-front:ropero:left')).toEqual(['210', '1974', '18'])
    expect(dimensions('back:column:0:module:0')).toEqual(['437', '1987', '20'])
    expect(groupCutlistPanels(compiled.panels, compiled.operations).find(g => g.representative.key.startsWith('interior-shelf:'))?.quantity).toBe(4)
    // El mecanizado conserva los 4,5 mm calculados, sin redondearlos a 5 mm.
    expect(compiled.operations.filter(op => op.operationType === 'rail-cut').every(op => op.depth === 0.0045)).toBe(true)
  })

  it.each([1, 3])('el fondo de cada cajón entra en las cuatro ranuras (%s cajones)', (count) => {
    const doc = wardrobe()
    doc.columns[0].modules = [{ id: 'cajonera', type: 'drawer', height: count * 0.2, drawerCount: count }]
    const result = compileAssembly(doc)
    const byKey = new Map(result.panels.map(p => [p.key, p]))
    for (let i = 0; i < count; i++) {
      const bottom = byKey.get(`drawer-bottom:cajonera:${i}`)!
      const front = byKey.get(`drawer-front:cajonera:${i}`)!
      const back = byKey.get(`drawer-back:cajonera:${i}`)!
      const left = byKey.get(`drawer-side:cajonera:${i}:left`)!
      const right = byKey.get(`drawer-side:cajonera:${i}:right`)!
      const reserve = doc.config.panelThickness / 4
      expect(bottom.position[2] + bottom.height / 2 - (front.position[2] - front.thickness / 2)).toBeCloseTo(reserve, 6)
      expect(back.position[2] + back.thickness / 2 - (bottom.position[2] - bottom.height / 2)).toBeCloseTo(reserve, 6)
      expect(left.position[0] + left.thickness / 2 - (bottom.position[0] - bottom.width / 2)).toBeCloseTo(reserve, 6)
      expect(bottom.position[0] + bottom.width / 2 - (right.position[0] - right.thickness / 2)).toBeCloseTo(reserve, 6)
      expect(panelCutlistOrientation(bottom)).toBe('horizontal')
      expect(panelCutlistOrientation(left)).toBe('vertical')
    }
  })

  it('cada ranura vertical del fondo se alinea con su módulo, sin duplicar una ranura de alto completo', () => {
    const doc = wardrobe()
    doc.columns[0].modules = [{ id: 'inferior', type: 'shelf', height: 0.6 }, { id: 'superior', type: 'doors', height: 1.4 }]
    const result = compileAssembly(doc)
    const side = result.panels.find(p => p.key === 'vertical:boundary:0')!
    const grooves = result.operations.filter(op => op.targetPanelKey === side.key)
    expect(grooves).toHaveLength(2)
    for (const op of grooves) {
      const back = result.panels.find(p => p.role === 'back-panel' && p.sourceModuleId === op.sourceModuleId)!
      expect(op.length).toBeCloseTo(back.height, 6)
      expect(op.center!.y + side.position[1]).toBeCloseTo(back.position[1], 6)
    }
    expect(grooves[0].center!.y).not.toBe(grooves[1].center!.y)
  })
})

describe('Agrupación e identificación', () => {
  it('separa paneles iguales con ranuras orientadas de forma distinta', () => {
    const panels = [panel('a'), panel('b')]
    const operations = [groove('a'), groove('b', Math.PI / 2)]
    expect(panelCutlistSignature(panels[0], operations)).not.toBe(panelCutlistSignature(panels[1], operations))
    const groups = groupCutlistPanels(panels, operations)
    expect(groups).toHaveLength(2)
    const rows = groupCutlistOperations(groups, operations)
    expect(rows.map(r => r.rotation).sort()).toEqual([0, 90])
  })

  it('usa los mismos códigos aunque las piezas lleguen en distinto orden', () => {
    const a = panel('a'), b = panel('b')
    const ops = [groove('a'), groove('b', Math.PI / 2)]
    const first = groupCutlistPanels([a, b], ops)
    const second = groupCutlistPanels([b, a], ops)
    expect(first.map(g => [g.key, g.groupId])).toEqual(second.map(g => [g.key, g.groupId]))
  })

  it('conserva las cantidades y distingue mecanizados por profundidad y posición', () => {
    const panels = [panel('a'), panel('b'), panel('c')]
    const ops = panels.flatMap(p => [groove(p.key), { ...groove(p.key), id: `otro:${p.key}`, center: { x: 0.01, y: 0.02 }, depth: 0.003 }])
    const groups = groupCutlistPanels(panels, ops)
    expect(groups).toHaveLength(1)
    expect(groups[0].quantity).toBe(3)
    const rows = groupCutlistOperations(groups, ops)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.quantity === 3 && r.groupId === groups[0].groupId)).toBe(true)
    expect(rows.map(r => r.depth).sort()).toEqual([0.003, 0.0045])
    expect(rows.map(r => r.x).sort()).toEqual([0, 0.01])
  })
})
