import type { H3Event } from 'h3'
import { createError, getHeader, getRequestIP, readBody, setHeader } from 'h3'
import { getCurrentUser } from '~~/server/utils/auth'
import { dbQuery } from '~~/server/utils/db'
import { hmacValue } from '~~/server/utils/security'
import { compileAssembly } from '~~/shared/domain/assembly'
import { LOCAL_AUTH_BYPASS_USER_ID } from '~~/shared/domain/auth'
import {
  AI_FURNITURE_PROMPT_MAX_LENGTH,
  AI_FURNITURE_RESPONSE_SCHEMA,
  applyAiFurniturePromptIntent,
  normalizeAiFurnitureCurrentDoc,
  normalizeAiFurnitureDraft,
  type AiFurnitureGenerateResponse,
} from '~~/shared/domain/ai-furniture'
import type { FurnitureDoc } from '~~/shared/domain/types'

const AI_USER_PER_HOUR = 10
const AI_USER_PER_DAY = 25
const AI_IP_PER_HOUR = 30
const AI_PLATFORM_PER_DAY = 1_000
const CLOUDFLARE_TIMEOUT_MS = 90_000
const CLOUDFLARE_MAX_OUTPUT_TOKENS = 1_000

interface GenerateBody {
  prompt?: unknown
  current?: unknown
  mode?: 'replace'
}

interface AiCaller {
  id: string
}

function hashedIp(event: H3Event): string {
  const ip = getRequestIP(event, { xForwardedFor: true }) || getHeader(event, 'x-real-ip') || 'unknown'
  return hmacValue(`ip:${ip}`)
}

function rateLimitError(event: H3Event, retryAfterSeconds: number, message = 'Too many AI generations. Try again later.'): never {
  setHeader(event, 'Retry-After', retryAfterSeconds)
  throw createError({
    statusCode: 429,
    statusMessage: message,
  })
}

async function getCaller(event: H3Event): Promise<AiCaller> {
  const config = useRuntimeConfig()
  const user = await getCurrentUser(event)
  if (user?.verified) return { id: user.id }
  if (user && !user.verified) {
    throw createError({ statusCode: 403, statusMessage: 'Verify your email to use AI generation.' })
  }
  if (import.meta.dev && config.aiFurnitureAllowLocalUnauth === true) {
    return { id: LOCAL_AUTH_BYPASS_USER_ID }
  }
  throw createError({ statusCode: 401, statusMessage: 'Sign in to use AI generation.' })
}

async function countAiEvents(where: string, params: unknown[]): Promise<number> {
  const result = await dbQuery<{ count: string }>(
    `SELECT count(*)::text AS count FROM ai_generation_events WHERE ${where}`,
    params,
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function reserveAiGeneration(event: H3Event, callerId: string, model: string, prompt: string): Promise<string> {
  const ipHash = hashedIp(event)
  const platformDay = await countAiEvents(
    "created_at > now() - interval '1 day'",
    [],
  )
  if (platformDay >= AI_PLATFORM_PER_DAY) {
    rateLimitError(event, 60 * 60 * 24, 'Daily AI generation capacity has been reached. Try again tomorrow.')
  }

  const userHour = await countAiEvents(
    "user_id = $1 AND created_at > now() - interval '1 hour'",
    [callerId],
  )
  if (userHour >= AI_USER_PER_HOUR) rateLimitError(event, 60 * 60)

  const userDay = await countAiEvents(
    "user_id = $1 AND created_at > now() - interval '1 day'",
    [callerId],
  )
  if (userDay >= AI_USER_PER_DAY) {
    rateLimitError(event, 60 * 60 * 24, 'Daily AI generation limit reached for this account.')
  }

  const ipHour = await countAiEvents(
    "ip_hash = $1 AND created_at > now() - interval '1 hour'",
    [ipHash],
  )
  if (ipHour >= AI_IP_PER_HOUR) rateLimitError(event, 60 * 60)

  const result = await dbQuery<{ id: string }>(
    'INSERT INTO ai_generation_events (user_id, ip_hash, model, prompt_hash) VALUES ($1, $2, $3, $4) RETURNING id::text AS id',
    [callerId, ipHash, model.slice(0, 180), hmacValue(`prompt:${prompt}`).slice(0, 180)],
  )
  return result.rows[0]?.id ?? ''
}

async function markAiGenerationEvent(id: string, status: 'succeeded' | 'failed', errorCode?: string): Promise<void> {
  if (!id) return
  try {
    await dbQuery(
      'UPDATE ai_generation_events SET status = $1, error_code = $2 WHERE id = $3',
      [status, errorCode ? errorCode.slice(0, 120) : null, id],
    )
  }
  catch {
    // Observability updates should never change the user-facing generation result.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('The model returned an empty response.')
  try {
    return JSON.parse(trimmed)
  }
  catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error('The model returned invalid JSON.')
  }
}

function collectOutputText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOutputText(item, out)
    return out
  }
  if (!isRecord(value)) return out
  if (typeof value.text === 'string' && (value.type === 'output_text' || value.type === 'text')) out.push(value.text)
  if ('content' in value) collectOutputText(value.content, out)
  if ('output' in value) collectOutputText(value.output, out)
  return out
}

function extractModelPayload(response: unknown): unknown {
  if (!isRecord(response)) throw new Error('Cloudflare returned an unexpected response.')
  const result = isRecord(response.result) ? response.result : response
  for (const key of ['response', 'output_text']) {
    const value = result[key]
    if (typeof value === 'string') return parseJsonText(value)
    if (isRecord(value)) return value
  }
  const texts = collectOutputText(result.output)
  if (texts.length > 0) return parseJsonText(texts.join('\n'))
  throw new Error('Cloudflare returned no model text.')
}

function roundMetric(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : 0
}

function compactConfig(current: FurnitureDoc) {
  const c = current.config
  return {
    d: c.depth,
    pt: c.panelThickness,
    bt: c.backPanelThickness,
    fc: c.frontClearance,
    so: c.sidePanelOverhang,
    pd: c.pullHoleDiameter,
    pe: c.pullHoleEdgeInset,
    pg: c.pullHolePairGap,
    cw: [c.minColumnWidth, c.maxColumnWidth],
    mh: [c.minModuleHeight, c.maxModuleHeight],
    dh: [c.minDrawerHeight, c.maxDrawerHeight],
  }
}

function compactModuleType(type: string): string {
  if (type === 'drawer') return 'd'
  if (type === 'doors') return 'D'
  if (type === 'left-door') return 'l'
  if (type === 'right-door') return 'r'
  return 's'
}

function compactCurrentDesign(current: FurnitureDoc): string {
  return JSON.stringify({
    g: compactConfig(current),
    tw: roundMetric(current.columns.reduce((sum, column) => sum + column.width, 0)),
    th: roundMetric(current.columns.reduce((max, column) => Math.max(max, column.modules.reduce((sum, module) => sum + module.height, 0)), 0)),
    c: current.columns.map(column => ({
      w: column.width,
      m: column.modules.map(module => ({
        t: compactModuleType(module.type),
        h: module.height,
        ...(module.type === 'drawer' ? { n: module.drawerCount ?? 1 } : {}),
        ...(module.interior ? { sc: module.interior.shelfCount } : {}),
      })),
    })),
  })
}

function furnitureInstructions(): string {
  return 'Return JSON only: {c:[{w,m:[{t,h,n?,sc?}]}],g?,s?,w?}. Units meters. t=s open,d drawer,D paired doors,l left door,r right door. sc=interior shelf count (0-32), independent of the front, supported for s,D,l,r. Modules are bottom-to-top. Use one d+n for a drawer bank. Fit requested width/height within g.cw and g.mh; practical cabinet/storage only; 1-8 cols; 1-12 modules/col. g keys: d depth,pt panel,bt back,fc front gap,so side overhang,pd pull diameter,pe pull inset,pg pull gap.'
}

function makeInput(prompt: string, current: FurnitureDoc, repairError?: string, badOutput?: unknown): string {
  const parts = [
    `P:${prompt}`,
    `C:${compactCurrentDesign(current)}`,
  ]
  if (repairError) {
    parts.push(`E:${repairError.replace(/\s+/g, ' ').slice(0, 260)}`)
    parts.push(`B:${JSON.stringify(badOutput).slice(0, 700)}`)
    parts.push('Fix and return complete JSON.')
  }
  return parts.join('\n\n')
}

async function callCloudflareAi(prompt: string, current: FurnitureDoc, repairError?: string, badOutput?: unknown): Promise<unknown> {
  const config = useRuntimeConfig()
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || config.cloudflareAccountId || '').trim()
  const apiToken = String(process.env.CLOUDFLARE_AI_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN || config.cloudflareAiApiToken || '').trim()
  const model = String(process.env.CLOUDFLARE_AI_MODEL || config.cloudflareAiModel || '@cf/openai/gpt-oss-120b').trim()
  if (!accountId || !apiToken) {
    throw createError({ statusCode: 503, statusMessage: 'Cloudflare AI is not configured.' })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CLOUDFLARE_TIMEOUT_MS)
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        model,
        instructions: furnitureInstructions(),
        input: makeInput(prompt, current, repairError, badOutput),
        max_tokens: CLOUDFLARE_MAX_OUTPUT_TOKENS,
        temperature: 0.15,
        top_p: 0.85,
        response_format: {
          type: 'json_schema',
          json_schema: AI_FURNITURE_RESPONSE_SCHEMA,
        },
      }),
    })
    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    }
    catch {
      json = { response: text }
    }
    if (!response.ok) {
      throw createError({
        statusCode: response.status === 408 ? 504 : 502,
        statusMessage: `Cloudflare AI request failed (${response.status}).`,
      })
    }
    return extractModelPayload(json)
  }
  catch (err: unknown) {
    if ((err as { name?: string } | null)?.name === 'AbortError') {
      throw createError({ statusCode: 504, statusMessage: 'Cloudflare AI timed out.' })
    }
    throw err
  }
  finally {
    clearTimeout(timer)
  }
}

function validateDraft(payload: unknown, current: FurnitureDoc, prompt: string) {
  const draft = applyAiFurniturePromptIntent(normalizeAiFurnitureDraft(payload, current.config), prompt)
  // AI edits the compartments; keep the construction chosen by the user.
  draft.doc.construction = current.construction
  draft.doc.exterior = current.exterior
  const compiled = compileAssembly(draft.doc)
  const errors = compiled.issues.filter(issue => issue.severity === 'error')
  if (errors.length > 0) {
    throw new Error(errors.map(issue => issue.message).slice(0, 4).join(' '))
  }
  const warnings = [
    ...draft.warnings,
    ...compiled.issues.filter(issue => issue.severity !== 'error').map(issue => issue.message),
  ]
  return {
    ...draft,
    warnings: [...new Set(warnings)].slice(0, 8),
  }
}

export default defineEventHandler(async (event): Promise<AiFurnitureGenerateResponse> => {
  const config = useRuntimeConfig()
  const model = String(process.env.CLOUDFLARE_AI_MODEL || config.cloudflareAiModel || '@cf/openai/gpt-oss-120b').trim()
  const caller = await getCaller(event)
  const body = await readBody<GenerateBody>(event)
  const prompt = typeof body.prompt === 'string' ? body.prompt.replace(/\s+/g, ' ').trim() : ''
  if (!prompt) throw createError({ statusCode: 400, statusMessage: 'Enter a prompt.' })
  if (prompt.length > AI_FURNITURE_PROMPT_MAX_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `Prompt must be ${AI_FURNITURE_PROMPT_MAX_LENGTH} characters or fewer.` })
  }
  if (body.mode !== undefined && body.mode !== 'replace') {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported generation mode.' })
  }
  if (!body.current || !isRecord(body.current) || !Array.isArray(body.current.columns) || !body.current.config) {
    throw createError({ statusCode: 400, statusMessage: 'Current design is required.' })
  }
  const current = normalizeAiFurnitureCurrentDoc(body.current)

  const generationEventId = await reserveAiGeneration(event, caller.id, model, prompt)

  try {
    const firstPayload = await callCloudflareAi(prompt, current)
    try {
      const draft = validateDraft(firstPayload, current, prompt)
      await markAiGenerationEvent(generationEventId, 'succeeded')
      return { draft }
    }
    catch (firstError: unknown) {
      try {
        const repairPayload = await callCloudflareAi(
          prompt,
          current,
          (firstError as { message?: string } | null)?.message ?? 'Invalid furniture layout.',
          firstPayload,
        )
        const draft = validateDraft(repairPayload, current, prompt)
        await markAiGenerationEvent(generationEventId, 'succeeded')
        return { draft }
      }
      catch (repairError: unknown) {
        throw createError({
          statusCode: 422,
          statusMessage: (repairError as { message?: string } | null)?.message || 'The generated layout could not be validated.',
        })
      }
    }
  }
  catch (err: unknown) {
    const status = (err as { statusCode?: number, status?: number } | null)?.statusCode
      ?? (err as { status?: number } | null)?.status
    await markAiGenerationEvent(generationEventId, 'failed', status ? `http_${status}` : 'generation_failed')
    throw err
  }
})
