import type { FurnitureConfig, FurnitureColumn, FurnitureConstruction, ExteriorDimensions } from './types'
import { normalizeConstruction } from './construction'

// FNV-1a 32-bit over a UTF-8 string.
function fnv1a32(str: string): number {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// Stable JSON serializer for the fingerprint payload.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}'
}

export function getProjectFingerprint(input: { columns: FurnitureColumn[], config: FurnitureConfig, construction?: FurnitureConstruction, exterior?: ExteriorDimensions }): string {
  const s = stableStringify({ columns: input.columns, config: input.config, construction: normalizeConstruction(input.construction), exterior: input.exterior ?? null })
  const h = fnv1a32(s).toString(16).padStart(8, '0')
  return `${s.length}:${h}`
}
