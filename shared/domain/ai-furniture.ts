import { normalizeExteriorDimensions } from './dimensions'
import {
  DEFAULT_FURNITURE_CONFIG,
  DRAWER_COUNT_MAX,
  DRAWER_COUNT_MIN,
  cryptoRandomId,
  snapConfig,
} from './defaults'
import { INTERIOR_SHELF_COUNT_MAX, normalizeShelfCount } from './interior'
import { normalizeConstruction } from './construction'
import {
  DESIGN_SCHEMA_VERSION,
  type FurnitureColumn,
  type FurnitureConfig,
  type FurnitureDoc,
  type FurnitureModule,
  type ModuleType,
} from './types'

export interface AiFurnitureDraft {
  doc: FurnitureDoc
  summary: string
  warnings: string[]
}

export interface AiFurnitureGenerateResponse {
  draft: AiFurnitureDraft
}

export const AI_FURNITURE_PROMPT_MAX_LENGTH = 1_200
export const AI_FURNITURE_MAX_COLUMNS = 8
export const AI_FURNITURE_MAX_MODULES_PER_COLUMN = 12

const MODULE_TYPES: ModuleType[] = ['shelf', 'drawer', 'doors', 'left-door', 'right-door']
const COMPACT_MODULE_TYPES = ['s', 'd', 'D', 'l', 'r'] as const
const COMPACT_TO_MODULE_TYPE: Record<string, ModuleType> = {
  s: 'shelf',
  d: 'drawer',
  D: 'doors',
  l: 'left-door',
  r: 'right-door',
}
const CONFIG_PATCH_KEYS: (keyof FurnitureConfig)[] = [
  'depth',
  'panelThickness',
  'backPanelThickness',
  'doorThickness',
  'drawerFrontThickness',
  'drawerPanelThickness',
  'drawerBottomThickness',
  'frontClearance',
  'sidePanelOverhang',
  'pullHoleDiameter',
  'pullHoleEdgeInset',
  'pullHolePairGap',
]
const COMPACT_CONFIG_PATCH_KEYS: Record<string, keyof FurnitureConfig> = {
  d: 'depth',
  pt: 'panelThickness',
  bt: 'backPanelThickness',
  fc: 'frontClearance',
  so: 'sidePanelOverhang',
  pd: 'pullHoleDiameter',
  pe: 'pullHoleEdgeInset',
  pg: 'pullHolePairGap',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim().replace(',', '.'))
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function snapMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function clamp(value: number, min: number, max: number): number {
  const upper = max >= min ? max : min
  return Math.min(upper, Math.max(min, value))
}

function normalizeModuleType(value: unknown): ModuleType {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const compact = COMPACT_TO_MODULE_TYPE[trimmed]
    if (compact) return compact
    const normalized = trimmed.toLowerCase()
    if (normalized === 'drawers') return 'drawer'
    if (MODULE_TYPES.includes(normalized as ModuleType)) return normalized as ModuleType
  }
  return 'shelf'
}

function cleanSummary(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback.slice(0, 240)
  const summary = value.replace(/\s+/g, ' ').trim()
  return (summary || fallback).slice(0, 240)
}

function cleanWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.replace(/\s+/g, ' ').trim().slice(0, 180))
    .filter(Boolean)
    .slice(0, 6)
}

function columnHeight(column: FurnitureColumn): number {
  return column.modules.reduce((sum, module) => sum + module.height, 0)
}

function cloneDraft(draft: AiFurnitureDraft): AiFurnitureDraft {
  return {
    summary: draft.summary,
    warnings: [...draft.warnings],
    doc: {
      schemaVersion: draft.doc.schemaVersion,
      lastAppliedMigrationId: draft.doc.lastAppliedMigrationId,
      config: { ...draft.doc.config },
      construction: normalizeConstruction(draft.doc.construction),
      ...(draft.doc.exterior ? { exterior: { ...draft.doc.exterior } } : {}),
      columns: draft.doc.columns.map(column => ({
        width: column.width,
        modules: column.modules.map(module => ({ ...module })),
      })),
    },
  }
}

function promptHasSideDoors(prompt: string): boolean {
  const p = prompt.toLowerCase()
  return /doors?\s+(?:on|at|for|in)\s+(?:the\s+)?(?:side|sides|outer|left\s+and\s+right|both\s+sides)\b/.test(p)
    || /(?:side|sides|outer|left\s+and\s+right|both\s+sides).{0,32}\bdoors?\b/.test(p)
}

function numberWordToInt(value: string): number | null {
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
  }
  if (/^\d+$/.test(value)) return Number(value)
  return words[value] ?? null
}

function requestedMiddleDrawerCount(prompt: string): number | null {
  const p = prompt.toLowerCase()
  const match = /\b(\d+|one|two|three|four|five|six|seven|eight)\s+drawers?\s+(?:in|on|for|at)\s+(?:the\s+)?(?:middle|center|centre)\b/.exec(p)
    ?? /\b(?:middle|center|centre).{0,32}\b(\d+|one|two|three|four|five|six|seven|eight)\s+drawers?\b/.exec(p)
  if (!match) return null
  const parsed = numberWordToInt(match[1] ?? '')
  return parsed == null ? null : Math.max(DRAWER_COUNT_MIN, Math.min(DRAWER_COUNT_MAX, parsed))
}

function promptKeepsMiddleShelves(prompt: string): boolean {
  return /\b(?:shelf|shelves|open)\b.{0,32}\b(?:middle|center|centre)\b/i.test(prompt)
    || /\b(?:middle|center|centre)\b.{0,32}\b(?:shelf|shelves|open)\b/i.test(prompt)
}

function makeModule(type: ModuleType, height: number, drawerCount?: number): FurnitureModule {
  const module: FurnitureModule = {
    id: cryptoRandomId(),
    type,
    height: snapMetric(height),
  }
  if (type === 'drawer') module.drawerCount = drawerCount ?? 1
  return module
}

function replaceColumnWithSingleModule(column: FurnitureColumn, type: ModuleType, config: FurnitureConfig, drawerCount?: number): FurnitureColumn {
  const targetHeight = Math.max(config.minModuleHeight, columnHeight(column) || 0.5)
  if (type !== 'drawer') {
    return { ...column, modules: [makeModule(type, clamp(targetHeight, config.minModuleHeight, config.maxModuleHeight))] }
  }
  const count = Math.max(DRAWER_COUNT_MIN, Math.min(DRAWER_COUNT_MAX, Math.round(drawerCount ?? 1)))
  const minHeight = count * config.minDrawerHeight
  const maxHeight = Math.min(config.maxModuleHeight, Math.max(minHeight, count * config.maxDrawerHeight))
  return {
    ...column,
    modules: [makeModule('drawer', clamp(targetHeight, minHeight, maxHeight), count)],
  }
}

export function applyAiFurniturePromptIntent(draft: AiFurnitureDraft, prompt: string): AiFurnitureDraft {
  const next = cloneDraft(draft)
  const columns = next.doc.columns
  if (columns.length === 0) return next
  let changed = false

  if (promptHasSideDoors(prompt) && columns.length >= 2) {
    columns[0] = replaceColumnWithSingleModule(columns[0], 'doors', next.doc.config)
    columns[columns.length - 1] = replaceColumnWithSingleModule(columns[columns.length - 1], 'doors', next.doc.config)
    changed = true
  }

  const middleDrawerCount = requestedMiddleDrawerCount(prompt)
  if (middleDrawerCount != null && columns.length >= 3 && !promptKeepsMiddleShelves(prompt)) {
    const middleIndex = Math.floor(columns.length / 2)
    columns[middleIndex] = replaceColumnWithSingleModule(columns[middleIndex], 'drawer', next.doc.config, middleDrawerCount)
    changed = true
  }

  if (changed) {
    const moduleCount = columns.reduce((sum, column) => sum + column.modules.length, 0)
    next.summary = `Generated ${columns.length}-column furniture layout with ${moduleCount} modules.`
  }

  return next
}

function normalizeConfigPatch(input: unknown, currentConfig: FurnitureConfig, warnings: string[]): FurnitureConfig {
  if (!isRecord(input)) return snapConfig(currentConfig)
  const patch: Partial<FurnitureConfig> = {}
  for (const key of CONFIG_PATCH_KEYS) {
    if (!(key in input)) continue
    const value = finiteNumber(input[key])
    if (value == null || value < 0) {
      warnings.push(`Ignored invalid ${key}.`)
      continue
    }
    patch[key] = value as FurnitureConfig[typeof key]
  }
  for (const [alias, key] of Object.entries(COMPACT_CONFIG_PATCH_KEYS)) {
    if (!(alias in input)) continue
    const value = finiteNumber(input[alias])
    if (value == null || value < 0) {
      warnings.push(`Ignored invalid ${key}.`)
      continue
    }
    patch[key] = value as FurnitureConfig[typeof key]
  }
  return snapConfig({ ...currentConfig, ...patch })
}

function normalizeDrawerCount(raw: unknown): number {
  const parsed = finiteNumber(raw)
  if (parsed == null) return 1
  return Math.max(DRAWER_COUNT_MIN, Math.min(DRAWER_COUNT_MAX, Math.round(parsed)))
}

function normalizeModule(raw: unknown, config: FurnitureConfig, warnings: string[]): FurnitureModule {
  const source = isRecord(raw) ? raw : {}
  const type = normalizeModuleType(source.type)
  const rawHeight = finiteNumber(source.height)
  let height = rawHeight == null ? config.minModuleHeight : rawHeight
  height = clamp(height, config.minModuleHeight, config.maxModuleHeight)

  const module: FurnitureModule = {
    id: cryptoRandomId(),
    type,
    height: snapMetric(height),
  }

  if (isRecord(source.interior)) {
    module.interior = { shelfCount: normalizeShelfCount(source.interior.shelfCount) }
  }
  if (type === 'drawer') {
    let drawerCount = normalizeDrawerCount(source.drawerCount)
    const maxByHeight = Math.max(1, Math.floor(module.height / Math.max(0.001, config.minDrawerHeight)))
    if (drawerCount > maxByHeight) {
      drawerCount = maxByHeight
      warnings.push('Reduced drawer count to fit the requested module height.')
    }
    const minHeight = drawerCount * config.minDrawerHeight
    const maxHeight = Math.max(minHeight, drawerCount * config.maxDrawerHeight)
    module.height = snapMetric(clamp(module.height, minHeight, Math.min(config.maxModuleHeight, maxHeight)))
    module.drawerCount = drawerCount
  }

  return module
}

function normalizeCompactModule(raw: unknown, config: FurnitureConfig, warnings: string[]): FurnitureModule {
  if (Array.isArray(raw)) {
    return normalizeModule({
      type: raw[0],
      height: raw[1],
      drawerCount: raw[2],
      interior: { shelfCount: raw[3] },
    }, config, warnings)
  }
  const source = isRecord(raw) ? raw : {}
  return normalizeModule({
    type: source.t ?? source.type,
    height: source.h ?? source.height,
    drawerCount: source.n ?? source.drawerCount,
    interior: source.interior ?? { shelfCount: source.sc },
  }, config, warnings)
}

function normalizeColumn(raw: unknown, config: FurnitureConfig, warnings: string[]): FurnitureColumn {
  const source = isRecord(raw) ? raw : {}
  const rawWidth = finiteNumber(source.width)
  const width = snapMetric(clamp(rawWidth ?? config.minColumnWidth, config.minColumnWidth, config.maxColumnWidth))
  const rawModules = Array.isArray(source.modules) ? source.modules : []
  if (rawModules.length === 0) warnings.push('Added a default shelf where the model returned an empty column.')
  if (rawModules.length > AI_FURNITURE_MAX_MODULES_PER_COLUMN) warnings.push(`Limited a column to ${AI_FURNITURE_MAX_MODULES_PER_COLUMN} modules.`)
  const modules = (rawModules.length > 0 ? rawModules : [{ type: 'shelf', height: Math.max(0.3, config.minModuleHeight) }])
    .slice(0, AI_FURNITURE_MAX_MODULES_PER_COLUMN)
    .map(item => normalizeModule(item, config, warnings))
  return { width, modules }
}

function normalizeCompactColumn(raw: unknown, config: FurnitureConfig, warnings: string[]): FurnitureColumn {
  if (Array.isArray(raw)) {
    return normalizeColumn({
      width: raw[0],
      modules: Array.isArray(raw[1]) ? raw[1] : [],
    }, config, warnings)
  }
  const source = isRecord(raw) ? raw : {}
  const rawWidth = finiteNumber(source.w ?? source.width)
  const width = snapMetric(clamp(rawWidth ?? config.minColumnWidth, config.minColumnWidth, config.maxColumnWidth))
  const rawModules = Array.isArray(source.m) ? source.m : Array.isArray(source.modules) ? source.modules : []
  if (rawModules.length === 0) warnings.push('Added a default shelf where the model returned an empty column.')
  if (rawModules.length > AI_FURNITURE_MAX_MODULES_PER_COLUMN) warnings.push(`Limited a column to ${AI_FURNITURE_MAX_MODULES_PER_COLUMN} modules.`)
  const modules = (rawModules.length > 0 ? rawModules : [{ t: 's', h: Math.max(0.3, config.minModuleHeight) }])
    .slice(0, AI_FURNITURE_MAX_MODULES_PER_COLUMN)
    .map(item => normalizeCompactModule(item, config, warnings))
  return { width, modules }
}

export function normalizeAiFurnitureCurrentDoc(input: unknown): FurnitureDoc {
  const source = isRecord(input) ? input : {}
  const warnings: string[] = []
  const config = normalizeConfigPatch(source.config, DEFAULT_FURNITURE_CONFIG, warnings)
  const rawColumns = Array.isArray(source.columns) ? source.columns : []
  const columns = rawColumns
    .slice(0, AI_FURNITURE_MAX_COLUMNS)
    .map(item => normalizeColumn(item, config, warnings))
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    lastAppliedMigrationId: null,
    config,
    columns,
    construction: normalizeConstruction(source.construction),
    ...(normalizeExteriorDimensions(source.exterior) ? { exterior: normalizeExteriorDimensions(source.exterior) } : {}),
  }
}

function normalizeCompactAiFurnitureDraft(input: Record<string, unknown>, currentConfig?: FurnitureConfig): AiFurnitureDraft {
  const warnings = cleanWarnings(input.w ?? input.warnings)
  const config = normalizeConfigPatch(input.g ?? input.config, currentConfig ?? DEFAULT_FURNITURE_CONFIG, warnings)
  const rawColumns = Array.isArray(input.c) ? input.c : []
  if (rawColumns.length === 0) throw new Error('The model did not return any columns.')
  if (rawColumns.length > AI_FURNITURE_MAX_COLUMNS) warnings.push(`Limited the result to ${AI_FURNITURE_MAX_COLUMNS} columns.`)
  const columns = rawColumns
    .slice(0, AI_FURNITURE_MAX_COLUMNS)
    .map(item => normalizeCompactColumn(item, config, warnings))
  const moduleCount = columns.reduce((sum, column) => sum + column.modules.length, 0)
  return {
    doc: {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      lastAppliedMigrationId: null,
      config,
      columns,
    },
    summary: cleanSummary(input.s ?? input.summary, `Generated ${columns.length}-column furniture layout with ${moduleCount} modules.`),
    warnings: [...new Set(warnings)].slice(0, 8),
  }
}

export function normalizeAiFurnitureDraft(input: unknown, currentConfig?: FurnitureConfig): AiFurnitureDraft {
  if (!isRecord(input)) throw new Error('The model returned an invalid furniture object.')
  if (Array.isArray(input.c)) return normalizeCompactAiFurnitureDraft(input, currentConfig)
  const warnings = cleanWarnings(input.warnings)
  const config = normalizeConfigPatch(input.config, currentConfig ?? DEFAULT_FURNITURE_CONFIG, warnings)
  const rawColumns = Array.isArray(input.columns) ? input.columns : []
  if (rawColumns.length === 0) throw new Error('The model did not return any columns.')
  if (rawColumns.length > AI_FURNITURE_MAX_COLUMNS) warnings.push(`Limited the result to ${AI_FURNITURE_MAX_COLUMNS} columns.`)
  const columns = rawColumns
    .slice(0, AI_FURNITURE_MAX_COLUMNS)
    .map(item => normalizeColumn(item, config, warnings))
  const moduleCount = columns.reduce((sum, column) => sum + column.modules.length, 0)
  return {
    doc: {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      lastAppliedMigrationId: null,
      config,
      columns,
    },
    summary: cleanSummary(input.summary, `Generated ${columns.length}-column furniture layout with ${moduleCount} modules.`),
    warnings: [...new Set(warnings)].slice(0, 8),
  }
}

export const AI_FURNITURE_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['c'],
  properties: {
    s: { type: 'string', maxLength: 120 },
    w: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', maxLength: 100 },
    },
    g: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.keys(COMPACT_CONFIG_PATCH_KEYS).map(key => [key, { type: 'number', minimum: 0 }]),
      ),
    },
    c: {
      type: 'array',
      minItems: 1,
      maxItems: AI_FURNITURE_MAX_COLUMNS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['w', 'm'],
        properties: {
          w: { type: 'number', minimum: 0.12, maximum: DEFAULT_FURNITURE_CONFIG.maxColumnWidth },
          m: {
            type: 'array',
            minItems: 1,
            maxItems: AI_FURNITURE_MAX_MODULES_PER_COLUMN,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['t', 'h'],
              properties: {
                t: {
                  type: 'string',
                  enum: COMPACT_MODULE_TYPES,
                },
                h: { type: 'number', minimum: 0.08, maximum: DEFAULT_FURNITURE_CONFIG.maxModuleHeight },
                n: { type: 'integer', minimum: DRAWER_COUNT_MIN, maximum: DRAWER_COUNT_MAX },
                sc: { type: 'integer', minimum: 0, maximum: INTERIOR_SHELF_COUNT_MAX },
              },
            },
          },
        },
      },
    },
  },
} as const
