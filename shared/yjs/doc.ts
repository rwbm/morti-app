import * as Y from 'yjs'
import { normalizeShelfCount } from '~~/shared/domain/interior'
import { inheritedThicknesses, NEW_THICKNESS_KEYS } from '~~/shared/domain/thickness'
import { CONSTRUCTION_PANEL_KEYS, normalizeConstruction } from '~~/shared/domain/construction'
import type { ConstructionPatch, FurnitureConstruction } from '~~/shared/domain/types'
import {
  DEFAULT_FURNITURE_CONFIG,
  defaultModule,
  defaultColumn,
  cryptoRandomId,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_SHELF_HEIGHT,
  DEFAULT_DRAWER_COUNT,
  DRAWER_COUNT_MAX,
  DRAWER_COUNT_MIN,
  FURNITURE_CONFIG_WRITABLE_KEYS,
} from '~~/shared/domain/defaults'
import {
  DESIGN_SCHEMA_VERSION,
  type FurnitureColumn,
  type FurnitureConfig,
  type FurnitureDoc,
  type FurnitureModule,
  type ModuleType,
} from '~~/shared/domain/types'

// Migrations table — each entry mutates the doc in place. Run once, in id order.
export const MIGRATIONS: { id: string, run(map: Y.Map<unknown>): void }[] = [
  {
    id: '1740000001000_legacy_furniture_config_keys',
    run(map) {
      const cfg = map.get('config') as Y.Map<unknown> | undefined
      if (!cfg) return
      const renames: [string, string][] = [
        ['frontReveal', 'frontClearance'],
        ['drawerDepthInset', 'drawerSlidesReserve'],
      ]
      for (const [from, to] of renames) {
        if (cfg.has(from)) {
          if (!cfg.has(to)) cfg.set(to, cfg.get(from))
          cfg.delete(from)
        }
      }
      cfg.delete('drawerInnerInset')
    },
  },
  {
    id: '1793059200000_full_height_modules',
    run(map) {
      const cfg = map.get('config') as Y.Map<unknown> | undefined
      // Keep custom limits; raise only the old defaults.
      for (const key of ['maxColumnWidth', 'maxModuleHeight'] as const) {
        if (cfg?.get(key) === 1.2) cfg.set(key, DEFAULT_FURNITURE_CONFIG[key])
      }
    },
  },
]

const ROOT_KEY = 'furniture'
const METRIC_STEP = 0.001
const METRIC_SCALE = Math.round(1 / METRIC_STEP)

function snapMetric(value: number): number {
  return Number.isFinite(value) ? Math.round(value * METRIC_SCALE) / METRIC_SCALE : 0
}

function sanitizeConfigValue<K extends keyof FurnitureConfig>(key: K, value: unknown): FurnitureConfig[K] {
  return (typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? snapMetric(value)
    : DEFAULT_FURNITURE_CONFIG[key]) as FurnitureConfig[K]
}

export function getFurnitureMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(ROOT_KEY)
}

export function ensureInitialized(doc: Y.Doc) {
  doc.transact(() => {
    const map = getFurnitureMap(doc)
    if (map.get('schemaVersion') !== DESIGN_SCHEMA_VERSION) map.set('schemaVersion', DESIGN_SCHEMA_VERSION)
    if (!map.has('lastAppliedMigrationId')) map.set('lastAppliedMigrationId', null)
    if (!map.has('config')) {
      const cfg = new Y.Map<unknown>()
      for (const k of FURNITURE_CONFIG_WRITABLE_KEYS) cfg.set(k, DEFAULT_FURNITURE_CONFIG[k])
      map.set('config', cfg)
    }
    else {
      const cfg = map.get('config') as Y.Map<unknown>
      const inherited = inheritedThicknesses(cfg.toJSON())
      for (const k of FURNITURE_CONFIG_WRITABLE_KEYS) {
        const value = cfg.get(k)
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          cfg.set(k, k in inherited ? inherited[k as keyof typeof inherited] : DEFAULT_FURNITURE_CONFIG[k])
        }
      }
    }
    runPendingMigrations(doc)
    if (!(map.get('construction') instanceof Y.Map)) {
      map.set('construction', toYConstruction(normalizeConstruction(map.get('construction'))))
    }
    if (!map.has('columns')) {
      const cols = new Y.Array<Y.Map<unknown>>()
      map.set('columns', cols)
    }
    const cols = map.get('columns') as Y.Array<Y.Map<unknown>>
    cols.forEach((col) => {
      const width = col.get('width')
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
        col.set('width', DEFAULT_COLUMN_WIDTH)
      }
      let modules = col.get('modules') as Y.Array<Y.Map<unknown>> | undefined
      if (!modules) {
        modules = new Y.Array<Y.Map<unknown>>()
        col.set('modules', modules)
      }
      if (modules.length === 0) modules.push([toYModule(defaultModule('shelf'))])
      modules.forEach((module) => {
        if (typeof module.get('id') !== 'string' || (module.get('id') as string).length === 0) {
          module.set('id', cryptoRandomId())
        }
        const rawType = module.get('type')
        const type = rawType === 'drawers' ? 'drawer' : rawType
        if (type !== 'shelf' && type !== 'drawer' && type !== 'doors' && type !== 'left-door' && type !== 'right-door') {
          module.set('type', 'shelf')
        }
        else if (type !== rawType) {
          module.set('type', type)
        }
        const height = module.get('height')
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
          module.set('height', DEFAULT_SHELF_HEIGHT)
        }
        if (module.get('type') === 'drawer') {
          const drawerCount = module.get('drawerCount')
          if (typeof drawerCount !== 'number' || !Number.isFinite(drawerCount)) {
            module.set('drawerCount', DEFAULT_DRAWER_COUNT)
          }
          else {
            module.set('drawerCount', Math.max(DRAWER_COUNT_MIN, Math.min(DRAWER_COUNT_MAX, Math.round(drawerCount))))
          }
        }
        else if (module.has('drawerCount')) {
          module.delete('drawerCount')
        }
      })
    })
  }, 'init')
}

export function runPendingMigrations(doc: Y.Doc) {
  const map = getFurnitureMap(doc)
  const last = (map.get('lastAppliedMigrationId') as string | null) ?? null
  let started = last === null
  for (const m of MIGRATIONS) {
    if (!started) {
      if (m.id === last) started = true
      continue
    }
    m.run(map)
    map.set('lastAppliedMigrationId', m.id)
  }
}

// ---------------- Pojo readers ----------------
export function readFurnitureDoc(doc: Y.Doc): FurnitureDoc {
  const map = getFurnitureMap(doc)
  const cfg = map.get('config') as Y.Map<unknown>
  const cols = map.get('columns') as Y.Array<Y.Map<unknown>>
  const config = { ...DEFAULT_FURNITURE_CONFIG, ...inheritedThicknesses(cfg?.toJSON() ?? {}) } as FurnitureConfig
  for (const k of FURNITURE_CONFIG_WRITABLE_KEYS) {
    const v = cfg?.get(k)
    config[k] = sanitizeConfigValue(k, v ?? config[k])
  }
  const columns: FurnitureColumn[] = []
  cols?.forEach((cm) => {
    const rawWidth = cm.get('width')
    const width = typeof rawWidth === 'number' && Number.isFinite(rawWidth) && rawWidth > 0 ? snapMetric(rawWidth) : DEFAULT_COLUMN_WIDTH
    const ms = cm.get('modules') as Y.Array<Y.Map<unknown>> | undefined
    const modules: FurnitureModule[] = []
    ms?.forEach((mm) => {
      const id = (mm.get('id') as string) ?? cryptoRandomId()
      const rawType = mm.get('type')
      const type: ModuleType = rawType === 'drawer' || rawType === 'doors' || rawType === 'left-door' || rawType === 'right-door' || rawType === 'shelf' ? rawType : 'shelf'
      const rawHeight = mm.get('height')
      const height = typeof rawHeight === 'number' && Number.isFinite(rawHeight) && rawHeight > 0 ? snapMetric(rawHeight) : DEFAULT_SHELF_HEIGHT
      const drawerCount = mm.get('drawerCount') as number | undefined
      const m: FurnitureModule = { id, type, height }
      const interior = mm.get('interior') as Y.Map<unknown> | undefined
      if (interior instanceof Y.Map) m.interior = { shelfCount: normalizeShelfCount(interior.get('shelfCount')) }
      if (type === 'drawer' && typeof drawerCount === 'number' && Number.isFinite(drawerCount)) {
        m.drawerCount = Math.max(DRAWER_COUNT_MIN, Math.min(DRAWER_COUNT_MAX, Math.round(drawerCount)))
      }
      modules.push(m)
    })
    columns.push({ width, modules })
  })
  return {
    schemaVersion: (map.get('schemaVersion') as number) ?? DESIGN_SCHEMA_VERSION,
    lastAppliedMigrationId: (map.get('lastAppliedMigrationId') as string | null) ?? null,
    config,
    columns,
    construction: readConstruction(doc),
  }
}

function readConstruction(doc: Y.Doc): FurnitureConstruction {
  const stored = getFurnitureMap(doc).get('construction')
  return normalizeConstruction(stored instanceof Y.Map ? stored.toJSON() : stored)
}

function toYConstruction(value: FurnitureConstruction): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  for (const key of CONSTRUCTION_PANEL_KEYS) map.set(key, value[key])
  const legs = new Y.Map<unknown>()
  for (const [key, v] of Object.entries(value.legs)) legs.set(key, v)
  map.set('legs', legs)
  return map
}

export function updateConstruction(doc: Y.Doc, patch: ConstructionPatch) {
  doc.transact(() => {
    const root = getFurnitureMap(doc)
    let map = root.get('construction') as Y.Map<unknown>
    if (!(map instanceof Y.Map)) {
      map = toYConstruction(readConstruction(doc))
      root.set('construction', map)
    }
    const current = readConstruction(doc)
    const next = normalizeConstruction({ ...current, ...patch, legs: { ...current.legs, ...patch.legs } })
    for (const key of CONSTRUCTION_PANEL_KEYS) {
      if (key in patch) map.set(key, next[key])
    }
    if (patch.legs) {
      let legs = map.get('legs') as Y.Map<unknown>
      if (!(legs instanceof Y.Map)) {
        legs = new Y.Map<unknown>()
        map.set('legs', legs)
      }
      for (const key of ['enabled', 'height', 'width', 'inset'] as const) {
        if (key in patch.legs) legs.set(key, next.legs[key])
      }
    }
  }, 'updateConstruction')
}

// ---------------- Y converters ----------------
export function toYModule(m: FurnitureModule): Y.Map<unknown> {
  const y = new Y.Map<unknown>()
  y.set('id', m.id)
  y.set('type', m.type)
  y.set('height', m.height)
  if (m.interior) {
    const interior = new Y.Map<unknown>()
    interior.set('shelfCount', normalizeShelfCount(m.interior.shelfCount))
    y.set('interior', interior)
  }
  if (typeof m.drawerCount === 'number') y.set('drawerCount', m.drawerCount)
  return y
}

export function toYColumn(c: FurnitureColumn): Y.Map<unknown> {
  const y = new Y.Map<unknown>()
  y.set('width', c.width)
  const arr = new Y.Array<Y.Map<unknown>>()
  arr.push(c.modules.map(toYModule))
  y.set('modules', arr)
  return y
}

// ---------------- Mutators ----------------
export function insertColumn(doc: Y.Doc, atIndex: number, width = DEFAULT_COLUMN_WIDTH) {
  doc.transact(() => {
    const cols = getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>
    cols.insert(atIndex, [toYColumn(defaultColumn(width))])
  }, 'insertColumn')
}

export function removeColumn(doc: Y.Doc, index: number) {
  doc.transact(() => {
    const cols = getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>
    cols.delete(index, 1)
  }, 'removeColumn')
}

export function setColumnWidth(doc: Y.Doc, index: number, width: number) {
  doc.transact(() => {
    const cols = getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>
    const col = cols.get(index)
    col?.set('width', typeof width === 'number' && Number.isFinite(width) && width > 0 ? snapMetric(width) : DEFAULT_COLUMN_WIDTH)
  }, 'setColumnWidth')
}

export function insertModule(doc: Y.Doc, columnIndex: number, atIndex: number, type: ModuleType) {
  doc.transact(() => {
    const cols = getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>
    const col = cols.get(columnIndex)
    const ms = col?.get('modules') as Y.Array<Y.Map<unknown>>
    const m: FurnitureModule = { id: cryptoRandomId(), type, height: DEFAULT_SHELF_HEIGHT }
    if (type === 'drawer') m.drawerCount = DEFAULT_DRAWER_COUNT
    ms.insert(atIndex, [toYModule(m)])
  }, 'insertModule')
}

export function removeModule(doc: Y.Doc, columnIndex: number, moduleIndex: number) {
  doc.transact(() => {
    const cols = getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>
    const ms = cols.get(columnIndex)?.get('modules') as Y.Array<Y.Map<unknown>>
    if (ms && moduleIndex >= 0 && moduleIndex < ms.length) ms.delete(moduleIndex, 1)
  }, 'removeModule')
}

export function setModuleType(doc: Y.Doc, columnIndex: number, moduleIndex: number, type: ModuleType) {
  doc.transact(() => {
    const ms = (getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>).get(columnIndex)?.get('modules') as Y.Array<Y.Map<unknown>>
    const m = ms.get(moduleIndex)
    m.set('type', type)
    if (type === 'drawer' && !m.has('drawerCount')) m.set('drawerCount', DEFAULT_DRAWER_COUNT)
    if (type !== 'drawer' && m.has('drawerCount')) m.delete('drawerCount')
  }, 'setModuleType')
}

export function setModuleHeight(doc: Y.Doc, columnIndex: number, moduleIndex: number, height: number) {
  doc.transact(() => {
    const ms = (getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>).get(columnIndex)?.get('modules') as Y.Array<Y.Map<unknown>>
    ms.get(moduleIndex)?.set('height', typeof height === 'number' && Number.isFinite(height) && height > 0 ? snapMetric(height) : 0.1)
  }, 'setModuleHeight')
}

export function setDrawerCount(doc: Y.Doc, columnIndex: number, moduleIndex: number, drawerCount: number) {
  doc.transact(() => {
    const ms = (getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>).get(columnIndex)?.get('modules') as Y.Array<Y.Map<unknown>>
    const m = ms.get(moduleIndex)
    if (!m) return
    m.set('drawerCount', Math.max(DRAWER_COUNT_MIN, Math.min(DRAWER_COUNT_MAX, Math.round(drawerCount))))
  }, 'setDrawerCount')
}

export function setInteriorShelfCount(doc: Y.Doc, columnIndex: number, moduleIndex: number, count: number) {
  doc.transact(() => {
    const cols = getFurnitureMap(doc).get('columns') as Y.Array<Y.Map<unknown>>
    const modules = cols.get(columnIndex)?.get('modules') as Y.Array<Y.Map<unknown>> | undefined
    const module = modules?.get(moduleIndex)
    if (!module || module.get('type') === 'drawer') return
    let interior = module.get('interior') as Y.Map<unknown> | undefined
    if (!(interior instanceof Y.Map)) {
      interior = new Y.Map<unknown>()
      module.set('interior', interior)
    }
    interior.set('shelfCount', normalizeShelfCount(count))
  }, 'setInteriorShelfCount')
}

export function setConfigValue<K extends keyof FurnitureConfig>(doc: Y.Doc, key: K, value: FurnitureConfig[K]) {
  doc.transact(() => {
    const cfg = getFurnitureMap(doc).get('config') as Y.Map<unknown>
    // Cubrir también documentos antiguos que sigan abiertos durante una actualización.
    if (cfg) {
      const inherited = inheritedThicknesses(cfg.toJSON())
      for (const inheritedKey of NEW_THICKNESS_KEYS) {
        if (!cfg.has(inheritedKey)) cfg.set(inheritedKey, inherited[inheritedKey])
      }
    }
    cfg?.set(key as string, sanitizeConfigValue(key, value))
  }, 'setConfigValue')
}

export function replaceFurnitureDoc(doc: Y.Doc, next: Pick<FurnitureDoc, 'config' | 'columns' | 'construction'>) {
  doc.transact(() => {
    const map = getFurnitureMap(doc)
    map.set('schemaVersion', DESIGN_SCHEMA_VERSION)
    map.set('construction', toYConstruction(normalizeConstruction(next.construction)))
    let cfg = map.get('config') as Y.Map<unknown> | undefined
    if (!cfg) {
      cfg = new Y.Map<unknown>()
      map.set('config', cfg)
    }
    const inherited = inheritedThicknesses(next.config)
    for (const key of FURNITURE_CONFIG_WRITABLE_KEYS) {
      cfg.set(key, sanitizeConfigValue(key, next.config[key] ?? (key in inherited ? inherited[key as keyof typeof inherited] : undefined)))
    }

    let cols = map.get('columns') as Y.Array<Y.Map<unknown>> | undefined
    if (!cols) {
      cols = new Y.Array<Y.Map<unknown>>()
      map.set('columns', cols)
    }
    if (cols.length > 0) cols.delete(0, cols.length)
    cols.insert(0, next.columns.map(toYColumn))
  })
}
