<script setup lang="ts">
import type * as Y from 'yjs'
import type { AiFurnitureDraft, AiFurnitureGenerateResponse } from '~~/shared/domain/ai-furniture'
import { AI_FURNITURE_PROMPT_MAX_LENGTH } from '~~/shared/domain/ai-furniture'
import { DEFAULT_COLUMN_WIDTH, DEFAULT_DRAWER_COUNT, DRAWER_COUNT_MAX, DRAWER_COUNT_MIN, DEFAULT_FURNITURE_CONFIG, FURNITURE_CONFIG_WRITABLE_KEYS, MODULE_TYPES } from '~~/shared/domain/defaults'
import type { FurnitureConfig, FurnitureModule, ModuleType } from '~~/shared/domain/types'
import { validateFurnitureDocIssues } from '~~/shared/domain/assembly-validation'
import { INTERIOR_SHELF_COUNT_MAX, interiorShelfCount } from '~~/shared/domain/interior'
import { normalizeConstruction } from '~~/shared/domain/construction'
import {
  insertColumn,
  insertModule,
  readFurnitureDoc,
  removeColumn,
  removeModule,
  replaceFurnitureDoc,
  setColumnWidth,
  setConfigValue,
  setDrawerCount,
  setExteriorDimensions,
  setInteriorShelfCount,
  setModuleHeight,
  setModuleType,
} from '~~/shared/yjs/doc'

interface Props {
  ydoc: Y.Doc
  selectedModules?: { id: string }[]
  zoomPercent?: number
}

const props = withDefaults(defineProps<Props>(), {
  selectedModules: () => [],
  zoomPercent: 100,
})

const emit = defineEmits<{
  (e: 'update:selectedModules', value: { id: string }[]): void
  (e: 'update:zoomPercent', value: number): void
}>()

const runtimeConfig = useRuntimeConfig()
const aiFurnitureEnabled = computed<boolean>(
  () => runtimeConfig.public.features?.promptFurniture === true,
)

// --- Reactive snapshot of the doc ---
const snapshot = ref(readFurnitureDoc(props.ydoc))

function refreshSnapshot() {
  snapshot.value = readFurnitureDoc(props.ydoc)
}

function onDocUpdate() {
  refreshSnapshot()
}

watch(
  () => props.ydoc,
  (next, prev) => {
    prev?.off('update', onDocUpdate)
    next?.on('update', onDocUpdate)
    refreshSnapshot()
  },
  { immediate: true },
)

if (getCurrentScope()) {
  onScopeDispose(() => {
    props.ydoc?.off('update', onDocUpdate)
  })
}

const columns = computed(() => snapshot.value.columns)
const config = computed<FurnitureConfig>(() => snapshot.value.config)
const construction = computed(() => normalizeConstruction(snapshot.value.construction))
const effectiveConfig = computed(() => config.value)

const internalSelectedIds = ref<string[]>([])
const clampedZoomPercent = computed<number>(() => {
  const z = props.zoomPercent
  return z === 25 || z === 50 || z === 75 || z === 100 ? z : 100
})
const selectedIds = computed<string[]>(() =>
  props.selectedModules.length > 0 ? props.selectedModules.map(s => s.id) : internalSelectedIds.value,
)
const selectedIdSet = computed(() => new Set(selectedIds.value))
const selectedModuleInfos = computed(() => {
  const infos: {
    id: string
    columnIndex: number
    moduleIndex: number
    columnWidth: number
    module: FurnitureModule
  }[] = []
  if (selectedIdSet.value.size === 0) return infos
  columns.value.forEach((col, columnIndex) => {
    col.modules.forEach((module, moduleIndex) => {
      if (selectedIdSet.value.has(module.id)) {
        infos.push({ id: module.id, columnIndex, moduleIndex, columnWidth: col.width, module })
      }
    })
  })
  return infos
})
const selectedCount = computed(() => selectedModuleInfos.value.length)
const inspectorIssues = computed<DesignerIssue[]>(() => validateFurnitureDocIssues(snapshot.value))
const visibleIssues = computed(() => {
  if (selectedCount.value === 0) return inspectorIssues.value.filter(issue => issue.moduleId == null)
  const ids = new Set(selectedModuleInfos.value.map(info => info.id))
  return inspectorIssues.value.filter(issue => issue.moduleId == null || ids.has(issue.moduleId))
})

// --- Selection helpers ---
function setSelection(ids: string[]) {
  internalSelectedIds.value = ids
  emit('update:selectedModules', ids.map(id => ({ id })))
}

function toggleModuleSelection(moduleId: string, shiftKey: boolean) {
  if (shiftKey) {
    const set = new Set(selectedIds.value)
    if (set.has(moduleId)) set.delete(moduleId)
    else set.add(moduleId)
    setSelection([...set])
  }
  else {
    setSelection([moduleId])
  }
}

function clearSelection() {
  setSelection([])
}

// --- Snapping (numeric clamp only — no snap lines) ---
function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const upper = max >= min ? max : min
  return Math.min(upper, Math.max(min, value))
}

function clampColumnWidth(w: number): number {
  return clampNumber(w, config.value.minColumnWidth, config.value.maxColumnWidth)
}

function clampDrawerCount(drawerCount: number): number {
  return Math.max(DRAWER_COUNT_MIN, Math.min(DRAWER_COUNT_MAX, Math.round(drawerCount)))
}

function drawerCountForHeight(module: FurnitureModule, height: number): number {
  const current = clampDrawerCount(module.drawerCount ?? DEFAULT_DRAWER_COUNT)
  if (module.type !== 'drawer' || !Number.isFinite(height) || height <= 0) return current
  const maxDrawerBandHeight = Math.max(config.value.minDrawerHeight, config.value.maxDrawerHeight)
  if (!Number.isFinite(maxDrawerBandHeight) || maxDrawerBandHeight <= 0) return current
  return clampDrawerCount(Math.max(current, Math.ceil(height / maxDrawerBandHeight - 1e-9)))
}

function clampModuleHeight(module: FurnitureModule, h: number): number {
  let min = config.value.minModuleHeight
  let max = config.value.maxModuleHeight
  if (max < min) max = min
  if (module.type === 'drawer') {
    const drawerCount = clampDrawerCount(module.drawerCount ?? DEFAULT_DRAWER_COUNT)
    const minDrawerHeight = drawerCount * config.value.minDrawerHeight
    const maxDrawerHeight = drawerCount * config.value.maxDrawerHeight
    min = Math.max(min, minDrawerHeight)
    max = Math.min(max, Math.max(minDrawerHeight, maxDrawerHeight))
  }
  return clampNumber(h, min, max)
}

function setModuleHeightWithDrawerClamp(columnIndex: number, moduleIndex: number, module: FurnitureModule, height: number) {
  let nextModule = module
  if (module.type === 'drawer') {
    const drawerCount = drawerCountForHeight(module, height)
    if (drawerCount !== (module.drawerCount ?? DEFAULT_DRAWER_COUNT)) {
      setDrawerCount(props.ydoc, columnIndex, moduleIndex, drawerCount)
      nextModule = { ...module, drawerCount }
    }
  }
  setModuleHeight(props.ydoc, columnIndex, moduleIndex, clampModuleHeight(nextModule, height))
}

// --- Module / column mutations ---
function defaultColumnWidth(): number {
  return DEFAULT_COLUMN_WIDTH
}

function keepInsertedColumnToDefaultShelf(index: number) {
  let moduleCount = readFurnitureDoc(props.ydoc).columns[index]?.modules.length ?? 0
  while (moduleCount > 1) {
    removeModule(props.ydoc, index, moduleCount - 1)
    moduleCount--
  }
}

function addColumnLeft() {
  insertColumn(props.ydoc, 0, defaultColumnWidth())
  keepInsertedColumnToDefaultShelf(0)
}

function addColumnRight() {
  const index = columns.value.length
  insertColumn(props.ydoc, index, defaultColumnWidth())
  keepInsertedColumnToDefaultShelf(index)
}

function removeColumnAt(index: number) {
  const removed = columns.value[index]
  removeColumn(props.ydoc, index)
  if (!removed) return
  const removedIds = new Set(removed.modules.map(m => m.id))
  setSelection(selectedIds.value.filter(id => !removedIds.has(id)))
}

function addModuleTop(columnIndex: number) {
  const col = columns.value[columnIndex]
  if (!col) return
  insertModule(props.ydoc, columnIndex, col.modules.length, 'shelf')
}

function setColumnWidthAt(columnIndex: number, w: number) {
  setColumnWidth(props.ydoc, columnIndex, clampColumnWidth(w))
}

function setModuleHeightAt(columnIndex: number, moduleIndex: number, h: number) {
  const module = columns.value[columnIndex]?.modules[moduleIndex]
  if (!module) return
  setModuleHeightWithDrawerClamp(columnIndex, moduleIndex, module, h)
}

function removeSelectedModule(columnIndex: number, moduleIndex: number) {
  const col = columns.value[columnIndex]
  const removed = col?.modules[moduleIndex]
  if (!col || !removed) return
  if (col.modules.length === 1) removeColumnAt(columnIndex)
  else {
    removeModule(props.ydoc, columnIndex, moduleIndex)
    setSelection(selectedIds.value.filter(id => id !== removed.id))
  }
}

function updateSelectedModulesType(type: ModuleType) {
  for (const info of selectedModuleInfos.value) {
    setModuleType(props.ydoc, info.columnIndex, info.moduleIndex, type)
    const module = readFurnitureDoc(props.ydoc).columns[info.columnIndex]?.modules[info.moduleIndex]
    if (module) setModuleHeightWithDrawerClamp(info.columnIndex, info.moduleIndex, module, module.height)
  }
}

function updateSelectedModulesColumnWidth(width: number) {
  const next = clampColumnWidth(width)
  const seen = new Set<number>()
  for (const info of selectedModuleInfos.value) {
    if (seen.has(info.columnIndex)) continue
    seen.add(info.columnIndex)
    setColumnWidth(props.ydoc, info.columnIndex, next)
  }
}

function updateSelectedModulesHeight(height: number) {
  for (const info of selectedModuleInfos.value) {
    setModuleHeightWithDrawerClamp(info.columnIndex, info.moduleIndex, info.module, height)
  }
}

function updateSelectedModulesDrawerCount(drawerCount: number) {
  const next = clampDrawerCount(drawerCount)
  for (const info of selectedModuleInfos.value) {
    if (info.module.type === 'drawer') {
      setDrawerCount(props.ydoc, info.columnIndex, info.moduleIndex, next)
      // La cantidad elegida es explícita: ajustar el alto, sin volver a agregar cajones.
      const height = clampModuleHeight({ ...info.module, drawerCount: next }, info.module.height)
      setModuleHeight(props.ydoc, info.columnIndex, info.moduleIndex, height)
    }
  }
}

// --- Column-resize drag (multi-target aware) ---
const Al = 220
const pxPerMeter = computed<number>(() => Al * (clampedZoomPercent.value / 100))

interface ColumnResizeState {
  startX: number
  direction: 1 | -1
  targets: { columnIndex: number, startWidth: number }[]
}
const columnResize = ref<ColumnResizeState | null>(null)

function onColumnResizeStart(columnIndex: number, direction: 1 | -1, ev: PointerEvent) {
  if (!columns.value[columnIndex]) return
  ev.preventDefault()
  cancelColumnResize()

  // Multi-target: if more than one column has at least one selected module,
  // drag all those columns at once.
  const selectedColumnIndices = new Set<number>()
  for (const id of selectedIds.value) {
    columns.value.forEach((col, ci) => {
      if (col.modules.some(m => m.id === id)) selectedColumnIndices.add(ci)
    })
  }

  let targets: { columnIndex: number, startWidth: number }[]
  if (selectedColumnIndices.size > 1) {
    targets = [...selectedColumnIndices].map(ci => ({
      columnIndex: ci,
      startWidth: columns.value[ci]?.width ?? 0,
    }))
  }
  else {
    targets = [{ columnIndex, startWidth: columns.value[columnIndex]?.width ?? 0 }]
  }

  columnResize.value = { startX: ev.clientX, direction, targets }
  if (import.meta.client) {
    window.addEventListener('pointermove', onColumnResizeMove)
    window.addEventListener('pointerup', cancelColumnResize)
    window.addEventListener('pointercancel', cancelColumnResize)
  }
}

function onColumnResizeMove(ev: PointerEvent) {
  const state = columnResize.value
  if (!state) return
  const dx = ev.clientX - state.startX
  const deltaMeters = (state.direction * dx) / pxPerMeter.value
  for (const t of state.targets) {
    setColumnWidth(props.ydoc, t.columnIndex, clampColumnWidth(t.startWidth + deltaMeters))
  }
}

function cancelColumnResize() {
  columnResize.value = null
  if (import.meta.client) {
    window.removeEventListener('pointermove', onColumnResizeMove)
    window.removeEventListener('pointerup', cancelColumnResize)
    window.removeEventListener('pointercancel', cancelColumnResize)
  }
}

if (getCurrentScope()) onScopeDispose(cancelColumnResize)

// --- Inspector / settings ---
interface DesignerIssue {
  code: string
  message: string
  severity: 'warning' | 'error'
  moduleId?: string | null
}

interface ConfigField {
  key: string
  label: string
  unit: 'm' | 'mm'
  help: string
}

const configFieldLabels: Record<string, { label: string, unit: 'm' | 'mm', help: string }> = {
  depth: { label: 'Depth', unit: 'm', help: 'Overall front-to-back depth of the furniture piece.' },
  panelThickness: { label: 'Panel thickness', unit: 'mm', help: 'Thickness of structural panels (sides, decks, dividers).' },
  doorThickness: { label: 'Espesor de puertas', unit: 'mm', help: 'Espesor de las puertas, independiente del cuerpo.' },
  drawerFrontThickness: { label: 'Espesor de frentes de cajón', unit: 'mm', help: 'Espesor de los frentes, independiente de la caja del cajón.' },
  drawerPanelThickness: { label: 'Espesor de cajas de cajón', unit: 'mm', help: 'Espesor de los laterales y traseras de los cajones.' },
  drawerBottomThickness: { label: 'Espesor de fondos de cajón', unit: 'mm', help: 'Espesor del fondo de los cajones; determina el ancho de sus ranuras.' },
  backPanelThickness: { label: 'Back panel thickness', unit: 'mm', help: 'Thickness of the back panel, typically thinner than structural panels.' },
  panelJointClearance: { label: 'Panel joint clearance', unit: 'mm', help: 'Small fit allowance at carcass joints and vertical gap above/below each drawer (same value subtracted at top and bottom of the drawer band).' },
  frontClearance: { label: 'Front clearance', unit: 'mm', help: 'Visible/functional gap around drawer and door fronts so they open without binding.' },
  sidePanelOverhang: { label: 'Side panel overhang', unit: 'mm', help: 'Extra height of the vertical side panels beyond the stacked module heights.' },
  pullHoleDiameter: { label: 'Pull hole diameter', unit: 'mm', help: 'Diameter of the circular finger-pull hole used to open drawers and doors.' },
  pullHoleEdgeInset: { label: 'Pull hole edge inset', unit: 'mm', help: 'Distance from the front edges to the center of each pull hole.' },
  pullHolePairGap: { label: 'Pull hole pair gap', unit: 'mm', help: 'Center-to-center distance between two pull holes when a module uses a pair.' },
  backPanelGrooveClearance: { label: 'Back panel groove clearance', unit: 'mm', help: 'Extra width on back-panel grooves beyond back panel thickness so the panel slides without binding.' },
  drawerBottomInset: { label: 'Drawer box vertical inset', unit: 'mm', help: 'Symmetric vertical inset for drawer side/back panels and the bottom board.' },
  drawerSlidesReserve: { label: 'Drawer slides reserve', unit: 'mm', help: 'Rear depth reserve for slide return, wiring, and related hardware.' },
  backPanelInset: { label: 'Back panel inset (rear hardware reserve)', unit: 'mm', help: 'Distance from the cabinet rear to the outer face of the carcass back panel.' },
  minColumnWidth: { label: 'Min column width', unit: 'm', help: 'Minimum width of a column when editing (meters). Values below this are clamped on commit.' },
  maxColumnWidth: { label: 'Max column width', unit: 'm', help: 'Maximum width of a column when editing (meters). Values above this are clamped on commit.' },
  minModuleHeight: { label: 'Min module height', unit: 'm', help: 'Minimum height of any module stack segment (meters).' },
  maxModuleHeight: { label: 'Max module height', unit: 'm', help: 'Maximum height of any module stack segment (meters).' },
  minDrawerHeight: { label: 'Min drawer band height', unit: 'm', help: 'Minimum height per drawer inside a drawer module (module height / drawer count).' },
  maxDrawerHeight: { label: 'Max drawer band height', unit: 'm', help: 'Maximum height per drawer inside a drawer module (module height / drawer count).' },
}

const projectDesignerConfigFields: ConfigField[] = FURNITURE_CONFIG_WRITABLE_KEYS.map((key) => {
  const meta = configFieldLabels[key]
  return {
    key,
    label: meta?.label ?? key,
    unit: meta?.unit ?? 'mm',
    help: meta?.help ?? key,
  }
})

const summaryConfigFields = projectDesignerConfigFields.filter(field =>
  field.key === 'depth' || field.key === 'panelThickness' || field.key === 'sidePanelOverhang',
)

const settingsOpen = ref(false)
const copiedConfig = ref(false)
let copiedConfigTimer: ReturnType<typeof setTimeout> | undefined

const aiBuildOpen = ref(false)
const aiPrompt = ref('')
const aiLoading = ref(false)
const aiError = ref('')
const aiDraft = ref<AiFurnitureDraft | null>(null)
const aiPromptInputRef = ref<HTMLTextAreaElement | null>(null)
let aiRequestSeq = 0
let aiAbortController: AbortController | null = null

const aiPromptLength = computed(() => aiPrompt.value.trim().length)
const aiDraftColumnCount = computed(() => aiDraft.value?.doc.columns.length ?? 0)
const aiDraftModuleCount = computed(() =>
  aiDraft.value?.doc.columns.reduce((sum, column) => sum + column.modules.length, 0) ?? 0,
)
const aiPromptOverLimit = computed(() => aiPromptLength.value > AI_FURNITURE_PROMPT_MAX_LENGTH)
const aiCanGenerate = computed(() =>
  aiPromptLength.value > 0
  && !aiPromptOverLimit.value
  && !aiLoading.value,
)
const aiPromptExamples = [
  {
    label: 'Media console',
    prompt: 'A 1.8m wide media console with 6 modules, doors on both sides, and drawers in the middle.',
  },
  {
    label: 'Bookshelf',
    prompt: 'A tall bookshelf with 4 even columns, mostly open shelves, and two lower drawers.',
  },
  {
    label: 'Wardrobe',
    prompt: 'A wardrobe with 3 wide columns, full-height doors on the sides, and stacked drawers in the center.',
  },
]

watch(selectedCount, (count) => {
  if (count === 0) return
  settingsOpen.value = false
  copiedConfig.value = false
  if (copiedConfigTimer !== undefined) {
    clearTimeout(copiedConfigTimer)
    copiedConfigTimer = undefined
  }
})

const selectedTypeValue = computed(() => {
  if (selectedModuleInfos.value.length === 0) return ''
  const first = selectedModuleInfos.value[0]?.module.type
  return first && selectedModuleInfos.value.every(info => info.module.type === first) ? first : '__multiple__'
})

const selectedColumnWidthValue = computed(() => {
  if (selectedModuleInfos.value.length === 0) return ''
  const first = selectedModuleInfos.value[0]?.columnWidth
  return typeof first === 'number' && selectedModuleInfos.value.every(info => info.columnWidth === first) ? String(first) : ''
})

const selectedHeightValue = computed(() => {
  if (selectedModuleInfos.value.length === 0) return ''
  const first = selectedModuleInfos.value[0]?.module.height
  return typeof first === 'number' && selectedModuleInfos.value.every(info => info.module.height === first) ? String(first) : ''
})

const furnitureDepthValue = computed(() => String(snapshot.value.exterior?.depth ?? config.value.depth))

function onFurnitureDepthCommit(event: Event) {
  const input = event.target as HTMLInputElement
  const value = parsePositiveMetric(input.value)
  if (value !== null && value <= 20) {
    if (snapshot.value.exterior) {
      setExteriorDimensions(props.ydoc, { ...snapshot.value.exterior, depth: value })
    }
    else {
      setConfigValue(props.ydoc, 'depth', value)
    }
  }
  input.value = furnitureDepthValue.value
}

const selectedDrawerCountValue = computed(() => {
  if (selectedTypeValue.value !== 'drawer') return ''
  const first = selectedModuleInfos.value[0]?.module.drawerCount
  return typeof first === 'number' && selectedModuleInfos.value.every(info => info.module.type === 'drawer' && info.module.drawerCount === first) ? String(first) : ''
})

const selectedSupportsShelves = computed(() => selectedCount.value > 0
  && selectedModuleInfos.value.every(info => info.module.type !== 'drawer'))
const selectedShelfCountValue = computed(() => {
  const first = selectedModuleInfos.value[0]?.module
  if (!first) return ''
  const count = interiorShelfCount(first)
  return selectedModuleInfos.value.every(info => interiorShelfCount(info.module) === count) ? String(count) : ''
})

const selectedTypeItems = computed(() => [
  { value: '__multiple__', label: 'Varios' },
  { value: 'shelf', label: 'Abierto' },
  { value: 'drawer', label: 'Cajones' },
  { value: 'doors', label: 'Dos puertas' },
  { value: 'left-door', label: 'Puerta con bisagra izquierda' },
  { value: 'right-door', label: 'Puerta con bisagra derecha' },
])

function parsePositiveMetric(value: string): number | null {
  const next = Number(value.trim().replace(',', '.'))
  return Number.isFinite(next) && next > 0 ? next : null
}

function parseNonNegativeMetric(value: string): number | null {
  if (value.trim() === '') return null
  const next = Number(value.trim().replace(',', '.'))
  return Number.isFinite(next) && next >= 0 ? next : null
}

function formatConfigValue(field: ConfigField) {
  const key = field.key as keyof FurnitureConfig
  const value = effectiveConfig.value[key] ?? DEFAULT_FURNITURE_CONFIG[key]
  if (!Number.isFinite(value)) return ''
  return field.unit === 'mm' ? String(Math.round(value * 1000)) : String(value)
}

function summaryLabel(field: ConfigField) {
  if (field.key === 'depth') return snapshot.value.exterior ? 'Profundidad del cuerpo' : 'Profundidad'
  if (field.key === 'panelThickness') return 'Thickness'
  if (field.key === 'sidePanelOverhang') return 'Overhang'
  return field.label
}

function updateConfigValue(key: string, value: number) {
  setConfigValue(props.ydoc, key as keyof FurnitureConfig, value as FurnitureConfig[keyof FurnitureConfig])
}

function commitConfigField(field: ConfigField, event: Event) {
  const input = event.target as HTMLInputElement | null
  if (!input) return
  const parsed = parseNonNegativeMetric(input.value)
  if (parsed == null) {
    input.value = formatConfigValue(field)
    return
  }
  updateConfigValue(field.key, field.unit === 'mm' ? parsed / 1000 : parsed)
  input.value = formatConfigValue(field)
}

function resetConfig() {
  for (const k of FURNITURE_CONFIG_WRITABLE_KEYS) {
    setConfigValue(props.ydoc, k, DEFAULT_FURNITURE_CONFIG[k])
  }
}

function configJson() {
  const values = projectDesignerConfigFields.reduce<Record<string, number>>((acc, field) => {
    const key = field.key as keyof FurnitureConfig
    acc[field.key] = effectiveConfig.value[key] ?? DEFAULT_FURNITURE_CONFIG[key]
    return acc
  }, {})
  return JSON.stringify(values, null, 2)
}

async function openAiBuilder() {
  aiError.value = ''
  aiDraft.value = null
  aiBuildOpen.value = true
  await nextTick()
  aiPromptInputRef.value?.focus()
}

async function useAiPromptExample(prompt: string) {
  if (aiLoading.value) return
  aiPrompt.value = prompt
  aiError.value = ''
  aiDraft.value = null
  await nextTick()
  aiPromptInputRef.value?.focus()
}

function abortAiGeneration() {
  aiRequestSeq++
  aiAbortController?.abort()
  aiAbortController = null
  aiLoading.value = false
}

watch(aiBuildOpen, (open) => {
  if (!open) abortAiGeneration()
})

function aiFetchErrorMessage(err: unknown): string {
  const error = err as {
    statusMessage?: string
    message?: string
    data?: { statusMessage?: string, message?: string }
  } | null
  return error?.data?.statusMessage
    || error?.statusMessage
    || error?.data?.message
    || error?.message
    || 'Could not generate furniture.'
}

async function generateAiFurniture() {
  const prompt = aiPrompt.value.trim()
  aiError.value = ''
  if (!prompt) {
    aiError.value = 'Enter a prompt.'
    return
  }
  if (prompt.length > AI_FURNITURE_PROMPT_MAX_LENGTH) {
    aiError.value = `Prompt must be ${AI_FURNITURE_PROMPT_MAX_LENGTH} characters or fewer.`
    return
  }
  aiAbortController?.abort()
  const requestSeq = ++aiRequestSeq
  const controller = new AbortController()
  aiAbortController = controller
  aiDraft.value = null
  aiLoading.value = true
  try {
    const response = await $fetch<AiFurnitureGenerateResponse>('/api/ai/furniture/generate', {
      method: 'POST',
      signal: controller.signal,
      body: {
        prompt,
        current: readFurnitureDoc(props.ydoc),
        mode: 'replace',
      },
    })
    if (requestSeq !== aiRequestSeq) return
    aiDraft.value = response.draft
  }
  catch (err: unknown) {
    if (requestSeq !== aiRequestSeq || controller.signal.aborted) return
    aiDraft.value = null
    aiError.value = aiFetchErrorMessage(err)
  }
  finally {
    if (requestSeq === aiRequestSeq) {
      aiLoading.value = false
      aiAbortController = null
    }
  }
}

function applyAiFurnitureDraft() {
  if (!aiDraft.value) return
  replaceFurnitureDoc(props.ydoc, aiDraft.value.doc)
  setSelection([])
  aiBuildOpen.value = false
  aiDraft.value = null
  aiError.value = ''
}

async function copyConfigJson() {
  const json = configJson()
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(json)
  }
  else {
    const textarea = document.createElement('textarea')
    textarea.value = json
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
  copiedConfig.value = true
  if (copiedConfigTimer) clearTimeout(copiedConfigTimer)
  copiedConfigTimer = setTimeout(() => {
    copiedConfig.value = false
    copiedConfigTimer = undefined
  }, 1200)
}

function onSelectedTypeChange(value: string) {
  if (value && value !== '__multiple__' && MODULE_TYPES.includes(value as ModuleType)) {
    updateSelectedModulesType(value as ModuleType)
  }
}

function onSelectedColumnWidthCommit(event: Event) {
  const input = event.target as HTMLInputElement | null
  if (!input) return
  const value = parsePositiveMetric(input.value)
  if (value == null) input.value = selectedColumnWidthValue.value
  else updateSelectedModulesColumnWidth(value)
}

function onSelectedHeightCommit(event: Event) {
  const input = event.target as HTMLInputElement | null
  if (!input) return
  const value = parsePositiveMetric(input.value)
  if (value == null) input.value = selectedHeightValue.value
  else updateSelectedModulesHeight(value)
}

function onSelectedDrawerCountCommit(event: Event) {
  const input = event.target as HTMLInputElement | null
  if (!input) return
  const value = Number(input.value.trim())
  const next = Math.round(value)
  if (!Number.isFinite(value) || next < DRAWER_COUNT_MIN || next > DRAWER_COUNT_MAX) {
    input.value = selectedDrawerCountValue.value
    return
  }
  updateSelectedModulesDrawerCount(next)
  input.value = String(next)
}

function onSelectedShelfCountCommit(event: Event) {
  const input = event.target as HTMLInputElement | null
  if (!input) return
  const value = input.value.trim() === '' ? NaN : Number(input.value)
  if (!Number.isInteger(value) || value < 0 || value > INTERIOR_SHELF_COUNT_MAX) {
    input.value = selectedShelfCountValue.value
    return
  }
  props.ydoc.transact(() => {
    for (const info of selectedModuleInfos.value) {
      setInteriorShelfCount(props.ydoc, info.columnIndex, info.moduleIndex, value)
    }
  }, 'setInteriorShelfCount')
  input.value = selectedShelfCountValue.value
}

if (getCurrentScope()) {
  onScopeDispose(() => {
    abortAiGeneration()
    if (copiedConfigTimer) clearTimeout(copiedConfigTimer)
  })
}
</script>

<template>
  <div class="designer-root relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg shadow-sm ring-1 ring-default/60">
    <ProjectDesignerFrontView
      :columns="columns"
      :config="config"
      :construction="construction"
      :selected-module-ids="selectedIds"
      :zoom-percent="clampedZoomPercent"
      class="relative z-0 min-h-0 w-full flex-1"
      @add-column-left="addColumnLeft"
      @add-column-right="addColumnRight"
      @clear-module-selection="clearSelection"
      @remove-column="removeColumnAt"
      @add-module-top="addModuleTop"
      @toggle-module-selection="toggleModuleSelection"
      @column-resize-start="onColumnResizeStart"
      @set-column-width="setColumnWidthAt"
      @set-module-height="setModuleHeightAt"
      @update:zoom-percent="(v: number) => emit('update:zoomPercent', v)"
    />

    <div class="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-4 sm:px-3 sm:pb-3 sm:pt-10">
      <div
        class="pointer-events-auto flex w-full max-w-2xl min-h-0 flex-col overflow-hidden rounded-xl bg-elevated shadow-lg ring-1 ring-default/60"
        :class="selectedCount > 0 ? 'max-h-[min(11rem,30dvh)] sm:max-h-[min(16rem,42vh)]' : 'max-h-[min(10rem,28dvh)] sm:max-h-[min(18rem,46vh)]'"
      >
        <div class="inspector-root grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-muted">
          <div
            v-if="visibleIssues.length > 0"
            class="px-3 py-3 sm:px-4"
          >
            <div class="grid auto-rows-auto gap-2">
              <div
                v-for="issue in visibleIssues"
                :key="issue.moduleId != null ? `${issue.moduleId}:${issue.code}` : issue.code"
                class="text-pretty rounded-lg px-3 py-2 text-xs shadow-sm ring-1"
                :class="issue.severity === 'error' ? 'bg-error/10 text-error ring-error/20' : 'bg-elevated text-default ring-default/60'"
              >
                {{ issue.message }}
              </div>
            </div>
          </div>

          <div class="min-h-0 overflow-auto p-3 sm:p-4">
            <div
              v-if="selectedCount > 0"
              class="grid gap-3"
            >
              <article class="grid gap-3 rounded-lg bg-default p-3 text-sm shadow-sm">
                <div class="flex min-w-0 items-center justify-between gap-2">
                  <h2 class="min-w-0 text-balance font-medium text-highlighted tabular-nums">
                    {{ selectedCount }} {{ selectedCount === 1 ? 'módulo seleccionado' : 'módulos seleccionados' }}
                  </h2>
                  <UButton
                    v-if="aiFurnitureEnabled"
                    color="primary"
                    icon="i-lucide-sparkles"
                    label="AI build"
                    size="xs"
                    variant="solid"
                    class="min-h-8 shrink-0 rounded-full px-3 shadow-sm transition-transform duration-150 active:scale-[0.97]"
                    @click="openAiBuilder"
                  />
                </div>

                <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  <dt class="self-center text-muted">
                    Frente
                  </dt>
                  <dd class="min-w-0">
                    <USelect
                      :model-value="selectedTypeValue || '__multiple__'"
                      :items="selectedTypeItems"
                      value-key="value"
                      class="w-full"
                      size="xs"
                      @update:model-value="onSelectedTypeChange"
                    />
                  </dd>

                  <dt class="self-center text-muted">
                    Ancho
                  </dt>
                  <dd class="min-w-0">
                    <div class="flex items-center gap-1">
                      <input
                        :value="selectedColumnWidthValue"
                        type="text"
                        inputmode="decimal"
                        class="w-full min-w-0 rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-highlighted shadow-sm outline-none ring-0 transition-colors duration-150 focus:bg-elevated"
                        placeholder="Varios"
                        aria-label="Ancho de las columnas seleccionadas en metros"
                        @keydown.enter.prevent="onSelectedColumnWidthCommit"
                        @blur="onSelectedColumnWidthCommit"
                      >
                      <span class="shrink-0 text-muted">m</span>
                    </div>
                  </dd>

                  <dt class="self-center text-muted">
                    Alto
                  </dt>
                  <dd class="min-w-0">
                    <div class="flex items-center gap-1">
                      <input
                        :value="selectedHeightValue"
                        type="text"
                        inputmode="decimal"
                        class="w-full min-w-0 rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-highlighted shadow-sm outline-none ring-0 transition-colors duration-150 focus:bg-elevated"
                        placeholder="Varios"
                        aria-label="Alto de los módulos seleccionados en metros"
                        @keydown.enter.prevent="onSelectedHeightCommit"
                        @blur="onSelectedHeightCommit"
                      >
                      <span class="shrink-0 text-muted">m</span>
                    </div>
                  </dd>

                  <dt class="self-center text-muted">Profundidad</dt>
                  <dd class="min-w-0">
                    <div class="flex items-center gap-1">
                      <input
                        :value="furnitureDepthValue"
                        type="text"
                        inputmode="decimal"
                        class="w-full min-w-0 rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-highlighted shadow-sm outline-none focus:bg-elevated"
                        aria-label="Profundidad del mueble en metros"
                        @keydown.enter.prevent="onFurnitureDepthCommit"
                        @blur="onFurnitureDepthCommit"
                      >
                      <span class="shrink-0 text-muted">m</span>
                    </div>
                    <p class="mt-1 text-muted">{{ snapshot.exterior ? 'Profundidad exterior total.' : 'Profundidad del cuerpo.' }} Se aplica a todo el mueble.</p>
                  </dd>

                  <template v-if="selectedTypeValue === 'drawer'">
                    <dt class="self-center text-muted">
                      Cajones
                    </dt>
                    <dd class="min-w-0">
                      <input
                        :value="selectedDrawerCountValue"
                        type="text"
                        inputmode="numeric"
                        class="w-full min-w-0 rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-highlighted shadow-sm outline-none ring-0 transition-colors duration-150 focus:bg-elevated"
                        placeholder="Varios"
                        aria-label="Cantidad de cajones en los módulos seleccionados"
                        @keydown.enter.prevent="onSelectedDrawerCountCommit"
                        @blur="onSelectedDrawerCountCommit"
                      >
                      <p class="mt-1 text-muted">De 1 a 32. El alto del bloque se ajusta si supera los límites por cajón.</p>
                    </dd>
                  </template>
                  <template v-if="selectedSupportsShelves">
                    <dt class="self-center text-muted">Estantes interiores</dt>
                    <dd class="min-w-0">
                      <input
                        :value="selectedShelfCountValue"
                        type="text"
                        inputmode="numeric"
                        class="w-full min-w-0 rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-highlighted shadow-sm outline-none focus:bg-elevated"
                        placeholder="Varios"
                        aria-label="Cantidad de estantes interiores en los módulos seleccionados"
                        @keydown.enter.prevent="onSelectedShelfCountCommit"
                        @blur="onSelectedShelfCountCommit"
                      >
                      <p class="mt-1 text-muted">Distribuidos a igual distancia. Usá 0 para dejar el interior vacío.</p>
                    </dd>
                  </template>
                </dl>

                <UButton
                  v-if="selectedModuleInfos[0]"
                  block
                  color="error"
                  icon="i-lucide-trash-2"
                  label="Eliminar módulo"
                  size="xs"
                  variant="soft"
                  class="justify-self-stretch active:scale-[0.97] transition-transform duration-150"
                  @click="removeSelectedModule(selectedModuleInfos[0].columnIndex, selectedModuleInfos[0].moduleIndex)"
                />
              </article>
            </div>

            <div
              v-else
              class="grid min-h-0 min-w-0 gap-2"
            >
              <button
                v-if="aiFurnitureEnabled"
                type="button"
                class="group flex min-h-10 w-full min-w-0 items-center gap-2 rounded-xl bg-primary px-2.5 py-1.5 text-left text-inverted shadow-md shadow-primary/20 ring-1 ring-inset ring-white/10 transition-[transform,box-shadow,filter] duration-150 ease-out hover:shadow-lg hover:shadow-primary/25 active:scale-[0.97] sm:min-h-14 sm:gap-3 sm:px-3 sm:py-2.5"
                aria-label="Build furniture with AI"
                @click="openAiBuilder"
              >
                <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-black/15 sm:size-9">
                  <UIcon
                    name="i-lucide-sparkles"
                    class="size-4 transition-transform duration-150 ease-out group-hover:scale-110 sm:size-5"
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-xs font-semibold leading-4 text-pretty sm:text-sm sm:leading-5">Build with AI</span>
                  <span class="hidden truncate text-xs leading-4 opacity-80 sm:block">Describe the cabinet and preview it before applying.</span>
                </span>
                <UIcon
                  name="i-lucide-arrow-right"
                  class="size-3.5 shrink-0 opacity-80 transition-transform duration-150 ease-out group-hover:translate-x-0.5 sm:size-4"
                />
              </button>

              <div
                class="relative min-h-0 min-w-0 cursor-pointer transition-transform duration-150 active:scale-[0.97]"
                @click="settingsOpen = true"
              >
                <div class="grid h-12 min-w-0 grid-cols-3 gap-1.5 pt-0.5 sm:h-40 sm:gap-2 sm:pt-1">
                  <article
                    v-for="field in summaryConfigFields"
                    :key="field.key"
                    class="flex min-w-0 flex-col rounded-lg bg-default px-1.5 py-1 shadow-sm sm:px-3 sm:py-2.5"
                  >
                    <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5 p-0.5 sm:gap-2 sm:p-2">
                      <h3 class="min-w-0 text-[0.55rem] font-medium leading-tight text-muted sm:text-balance sm:text-[0.7rem] sm:leading-snug">
                        {{ summaryLabel(field) }} ({{ field.unit }})
                      </h3>
                      <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0 sm:pb-2">
                        <span class="min-w-0 text-sm font-extralight leading-none tracking-normal tabular-nums text-highlighted sm:text-[2.75rem]">
                          {{ formatConfigValue(field) }}
                        </span>
                      </div>
                    </div>
                  </article>
                </div>

                <AppDialog
                  v-model:open="settingsOpen"
                  title="Project settings"
                  description="All values apply to the assembly preview and cutlist."
                >
                  <div class="flex flex-wrap items-center justify-end gap-1 border-b border-default pb-3">
                    <UButton
                      icon="i-lucide-rotate-ccw"
                      label="Reset"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      aria-label="Reset project settings to defaults"
                      class="active:scale-[0.97] transition-transform duration-150"
                      @click="resetConfig"
                    />
                    <UButton
                      :icon="copiedConfig ? 'i-lucide-check' : 'i-lucide-copy'"
                      :label="copiedConfig ? 'Copied' : 'Copy JSON'"
                      size="xs"
                      color="neutral"
                      variant="soft"
                      aria-label="Copy project settings as JSON"
                      class="active:scale-[0.97] transition-transform duration-150"
                      @click="copyConfigJson"
                    />
                  </div>

                  <dl class="grid max-h-[min(24rem,55vh)] grid-cols-[1fr_auto] gap-x-3 gap-y-2 overflow-y-auto pr-1 text-xs">
                    <p v-if="snapshot.exterior" class="col-span-2 rounded-md bg-muted p-2 text-xs text-muted">El tamaño exterior está fijado. Modificá sus medidas en Estructura; la profundidad del cuerpo se calcula automáticamente.</p>
                    <template
                      v-for="field in projectDesignerConfigFields"
                      :key="field.key"
                    >
                      <dt class="flex min-w-0 items-center gap-1 self-center text-muted">
                        <span class="truncate">{{ field.label }}</span>
                        <UTooltip
                          :text="field.help"
                          :delay-duration="100"
                          :content="{ side: 'left', sideOffset: 6 }"
                        >
                          <button
                            type="button"
                            class="config-help-icon active:scale-[0.97] transition-transform duration-150"
                            :aria-label="`${field.label} help`"
                          >
                            <UIcon
                              name="i-lucide-circle-help"
                              class="size-3.5"
                            />
                          </button>
                        </UTooltip>
                      </dt>
                      <dd>
                        <div class="flex items-center gap-1">
                          <input
                            :value="formatConfigValue(field)"
                            :disabled="field.key === 'depth' && !!snapshot.exterior"
                            type="text"
                            inputmode="decimal"
                            class="w-20 rounded-md bg-muted px-2 py-1 text-right text-xs tabular-nums text-highlighted shadow-sm outline-none ring-0 transition-colors duration-150 focus:bg-elevated"
                            :aria-label="`${field.label} (${field.unit})`"
                            @keydown.enter.prevent="commitConfigField(field, $event)"
                            @blur="commitConfigField(field, $event)"
                          >
                          <span class="text-muted lowercase">{{ field.unit }}</span>
                        </div>
                      </dd>
                    </template>
                  </dl>

                  <template #footer="{ close }">
                    <UButton
                      label="Done"
                      color="neutral"
                      variant="outline"
                      class="w-full min-w-0 justify-center active:scale-[0.97] transition-transform duration-150"
                      @click="close()"
                    />
                  </template>
                </AppDialog>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <AppDialog
      v-model:open="aiBuildOpen"
      title="Build with AI"
      description="Describe the cabinet you want. You can preview the layout before it replaces the current design."
      size="lg"
    >
      <div class="grid gap-4">
        <div class="grid gap-3 rounded-xl bg-muted p-3 shadow-sm ring-1 ring-default/60">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <label
              for="ai-build-prompt"
              class="text-sm font-medium text-highlighted"
            >
              Prompt
            </label>
            <span
              class="text-[11px] tabular-nums"
              :class="aiPromptOverLimit ? 'text-error' : 'text-muted'"
            >
              {{ aiPromptLength }} / {{ AI_FURNITURE_PROMPT_MAX_LENGTH }}
            </span>
          </div>
          <textarea
            id="ai-build-prompt"
            ref="aiPromptInputRef"
            v-model="aiPrompt"
            rows="5"
            :maxlength="AI_FURNITURE_PROMPT_MAX_LENGTH"
            placeholder="e.g. 1.8m wide media console, three columns, drawers in the middle, doors on both sides"
            :disabled="aiLoading"
            class="block min-h-36 w-full resize-y rounded-lg bg-default px-3 py-3 text-sm leading-6 text-highlighted shadow-sm outline-none ring-1 ring-default/70 transition-[background-color,box-shadow] duration-150 placeholder:text-muted focus:bg-elevated focus:ring-2 focus:ring-primary/70 disabled:cursor-not-allowed disabled:opacity-60"
            @keydown.meta.enter.prevent="generateAiFurniture"
            @keydown.ctrl.enter.prevent="generateAiFurniture"
          />

          <div class="flex min-w-0 flex-wrap gap-1.5">
            <button
              v-for="example in aiPromptExamples"
              :key="example.label"
              type="button"
              class="min-h-8 rounded-full bg-elevated px-3 text-xs font-medium text-toned shadow-sm ring-1 ring-default/60 transition-[transform,background-color,color] duration-150 hover:bg-accented hover:text-highlighted active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="aiLoading"
              @click="useAiPromptExample(example.prompt)"
            >
              {{ example.label }}
            </button>
          </div>
        </div>
      </div>

      <UAlert
        v-if="aiError"
        color="error"
        variant="soft"
        :title="aiError"
      />

      <div
        v-if="aiLoading"
        class="flex min-h-28 items-center gap-3 rounded-xl bg-muted p-4 shadow-sm ring-1 ring-default/60"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 shrink-0 animate-spin text-primary"
        />
        <div class="min-w-0">
          <p class="text-sm font-medium text-highlighted">
            Generating layout
          </p>
          <p class="text-pretty text-xs text-muted">
            Checking dimensions, modules, and hardware clearances.
          </p>
        </div>
      </div>

      <div
        v-if="aiDraft"
        class="grid gap-3 rounded-xl bg-default p-3 shadow-sm ring-1 ring-default/60 sm:grid-cols-[minmax(0,1.1fr)_minmax(12rem,0.9fr)]"
      >
        <div class="min-w-0 overflow-hidden rounded-lg bg-muted p-2 ring-1 ring-default/50">
          <ProjectPreview
            :columns="aiDraft.doc.columns"
            :config="aiDraft.doc.config"
            :construction="aiDraft.doc.construction"
          />
        </div>
        <div class="grid gap-2 text-xs">
          <p class="text-[11px] font-semibold uppercase tracking-normal text-muted">
            Preview summary
          </p>
          <p class="text-pretty text-highlighted">
            {{ aiDraft.summary }}
          </p>
          <div class="flex flex-wrap gap-1.5">
            <UBadge
              color="neutral"
              variant="soft"
              size="sm"
            >
              {{ aiDraftColumnCount }} columns
            </UBadge>
            <UBadge
              color="neutral"
              variant="soft"
              size="sm"
            >
              {{ aiDraftModuleCount }} modules
            </UBadge>
          </div>
          <ul
            v-if="aiDraft.warnings.length > 0"
            class="grid gap-1 rounded-lg bg-muted p-2 text-muted"
          >
            <li
              v-for="warning in aiDraft.warnings"
              :key="warning"
              class="text-pretty"
            >
              {{ warning }}
            </li>
          </ul>
        </div>
      </div>

      <template #footer="{ close }">
        <div class="grid w-full grid-cols-2 gap-2">
          <UButton
            :label="aiDraft ? 'Close' : 'Cancel'"
            color="neutral"
            variant="outline"
            class="w-full min-h-10 min-w-0 justify-center transition-transform active:scale-[0.97]"
            :disabled="aiLoading"
            @click="close()"
          />
          <UButton
            v-if="!aiDraft"
            label="Generate layout"
            icon="i-lucide-sparkles"
            class="w-full min-h-10 min-w-0 justify-center transition-transform active:scale-[0.97]"
            :loading="aiLoading"
            :disabled="!aiCanGenerate"
            @click="generateAiFurniture"
          />
          <UButton
            v-else
            label="Apply"
            icon="i-lucide-check"
            class="w-full min-h-10 min-w-0 justify-center transition-transform active:scale-[0.97]"
            :disabled="aiLoading"
            @click="applyAiFurnitureDraft"
          />
        </div>
        <UButton
          v-if="aiDraft"
          block
          label="Regenerate"
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="soft"
          class="mt-2 min-h-10 justify-center transition-transform active:scale-[0.97]"
          :loading="aiLoading"
          @click="generateAiFurniture"
        />
      </template>
    </AppDialog>
  </div>
</template>

<style scoped>
.designer-root {
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
}
.config-help-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-text-muted);
  border-radius: 9999px;
  outline: none;
  cursor: help;
  transition: color 0.15s;
}
.config-help-icon:hover,
.config-help-icon:focus-visible {
  color: var(--ui-text-highlighted);
}
</style>
