<script setup lang="ts">
import ProjectFrontLegs from './ProjectFrontLegs.vue'
import type { FurnitureColumn, FurnitureConfig, FurnitureModule, FurnitureConstruction } from '~~/shared/domain/types'
import { interiorShelfCount } from '~~/shared/domain/interior'
import { constructionBodyLift, normalizeConstruction } from '~~/shared/domain/construction'

interface Props {
  columns: FurnitureColumn[]
  config: FurnitureConfig
  selectedModuleIds: string[]
  zoomPercent: number
  construction?: FurnitureConstruction
}

const props = defineProps<Props>()
const structure = computed(() => normalizeConstruction(props.construction))
const legLift = computed(() => constructionBodyLift(structure.value, props.config))

const emit = defineEmits<{
  (e: 'add-column-left'): void
  (e: 'add-column-right'): void
  (e: 'clear-module-selection'): void
  (e: 'remove-column', columnIndex: number): void
  (e: 'add-module-top', columnIndex: number): void
  (e: 'update:zoom-percent', value: number): void
  (e: 'toggle-module-selection', moduleId: string, shiftKey: boolean): void
  (e: 'column-resize-start', columnIndex: number, direction: 1 | -1, event: PointerEvent): void
  (e: 'set-column-width', columnIndex: number, width: number): void
  (e: 'set-module-height', columnIndex: number, moduleIndex: number, height: number): void
}>()

// --- Layout / drag-handle constants (verbatim from spec 04 §4.3) ---
const Al = 220 // base px-per-meter at 100% zoom
const Vl = 28 // column-add buttons width/height
const Kl = 28 // column meta footer offset
const Bt = 10 // gap above the top-of-column "+" button
const qt = 4 // column outer padding
const Ke = 4 // column-resize divider lateral margin
const We = 4 // column-resize divider width / module-boundary spacer height
const zt = 6 // module-boundary drag-handle height
const ALLOWED_ZOOMS = [100, 75, 50, 25] as const
const OUTER_RAIL_GAP = 12 // gap-3 between side add buttons and the rail
const VIEWPORT_INLINE_PADDING = 32 // p-4 on the scroll content
const MIN_FIT_PX_PER_METER = 64

const clampedZoom = computed<number>(() => {
  const z = props.zoomPercent
  return ALLOWED_ZOOMS.includes(z as typeof ALLOWED_ZOOMS[number]) ? z : 100
})

const viewportRef = ref<HTMLElement | null>(null)
const viewportWidth = ref(0)
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!viewportRef.value) return
  resizeObserver = new ResizeObserver(([entry]) => {
    viewportWidth.value = entry?.contentRect.width ?? 0
  })
  resizeObserver.observe(viewportRef.value)
  viewportWidth.value = viewportRef.value.getBoundingClientRect().width
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

const basePxPerMeter = computed<number>(() => Al * (clampedZoom.value / 100))
const totalColumnWidthMeters = computed<number>(() =>
  props.columns.reduce((sum, col) => sum + Math.max(0, col.width), 0),
)
const fitPxPerMeter = computed<number>(() => {
  const meters = totalColumnWidthMeters.value
  const available = viewportWidth.value - VIEWPORT_INLINE_PADDING
  if (props.columns.length === 0 || meters <= 0 || available <= 0) return basePxPerMeter.value

  const staticWidth = 2 * Vl + 2 * OUTER_RAIL_GAP + (props.columns.length + 1) * (We + Ke)
  const fitted = (available - staticWidth) / meters
  if (!Number.isFinite(fitted) || fitted <= 0) {
    return Math.min(basePxPerMeter.value, MIN_FIT_PX_PER_METER)
  }

  return Math.max(MIN_FIT_PX_PER_METER, Math.min(basePxPerMeter.value, fitted))
})

// pixels per metre at the current zoom, auto-fitted when the rail is wider than the viewport
const pxPerMeter = computed<number>(() => fitPxPerMeter.value)

const selectedSet = computed<Set<string>>(() => new Set(props.selectedModuleIds))
const anySelected = computed<boolean>(() => selectedSet.value.size > 0)
const selectedFillClass = computed<string>(() => anySelected.value ? 'bg-inverted opacity-30' : 'bg-primary')

function isSelected(moduleId: string): boolean {
  return selectedSet.value.has(moduleId)
}

function moduleClass(mod: FurnitureModule): string {
  const moduleIsSelected = isSelected(mod.id)
  if (mod.type === 'shelf') {
    if (anySelected.value && !moduleIsSelected) return 'module-shelf module-shelf-dim'
    if (moduleIsSelected) return 'module-shelf module-shelf-selected'
    return 'module-shelf'
  }
  if (!anySelected.value || moduleIsSelected) return 'bg-primary'
  return 'bg-inverted opacity-10 ring ring-default/60 hover:opacity-10'
}

function meterToPx(m: number): number {
  if (!Number.isFinite(m) || m <= 0) return 0
  return Math.round(m * pxPerMeter.value)
}

function px(m: number): string {
  return `${meterToPx(m)}px`
}

function formatMeasurement(n: number): string {
  return Number.isFinite(n) ? String(n) : ''
}

function pullHoleEdgeInset(): number {
  return props.config.pullHoleEdgeInset
}

function pullDiameterPx(): number {
  return Math.max(3, Math.round(props.config.pullHoleDiameter * pxPerMeter.value))
}

function pullEdgeInsetPx(): number {
  return Math.round(pullHoleEdgeInset() * pxPerMeter.value)
}

function pullPairHalfGapPx(): number {
  return Math.round((props.config.pullHolePairGap / 2) * pxPerMeter.value)
}

function visualBgClass(): string {
  return 'bg-[var(--ui-bg-muted)]'
}

function leftDoorPullStyle(): Record<string, string> {
  const d = pullDiameterPx()
  const r = d / 2
  const inset = pullEdgeInsetPx()
  return {
    width: `${d}px`,
    height: `${d}px`,
    top: `${inset - r}px`,
    right: `${inset - r}px`,
  }
}

function rightDoorPullStyle(): Record<string, string> {
  const d = pullDiameterPx()
  const r = d / 2
  const inset = pullEdgeInsetPx()
  return {
    width: `${d}px`,
    height: `${d}px`,
    top: `${inset - r}px`,
    left: `${inset - r}px`,
  }
}

function doorsPullStyle(side: 'left' | 'right'): Record<string, string> {
  const d = pullDiameterPx()
  const r = d / 2
  const inset = pullEdgeInsetPx()
  const halfGap = pullPairHalfGapPx()
  const offset = side === 'left' ? -halfGap : halfGap
  return {
    width: `${d}px`,
    height: `${d}px`,
    top: `${inset - r}px`,
    left: `calc(50% + ${offset - r}px)`,
  }
}

function doorDividerStyle(): Record<string, string> {
  return {
    width: '2px',
    left: '50%',
    top: '0',
    bottom: '0',
    transform: 'translateX(-50%)',
  }
}

function drawerPullStyle(mod: FurnitureModule, drawerIndex: number, side: 'left' | 'right'): Record<string, string> {
  const d = pullDiameterPx()
  const r = d / 2
  const total = drawerCount(mod)
  const topM = (drawerIndex / total) * mod.height
  const bottomM = ((drawerIndex - 1) / total) * mod.height
  let centreM = topM - pullHoleEdgeInset()
  const minCentre = bottomM + props.config.pullHoleDiameter / 2
  const maxCentre = topM - props.config.pullHoleDiameter / 2
  if (centreM < minCentre) centreM = minCentre
  if (centreM > maxCentre) centreM = maxCentre
  const pct = (centreM / mod.height) * 100
  const halfGap = pullPairHalfGapPx()
  const offset = side === 'left' ? -halfGap : halfGap
  return {
    width: `${d}px`,
    height: `${d}px`,
    left: `calc(50% + ${offset - r}px)`,
    bottom: `calc(${pct}% - ${r}px)`,
  }
}

function drawerCount(mod: FurnitureModule): number {
  return mod.drawerCount as number
}

function spacerStyle(axis: 'width' | 'height'): Record<string, string> {
  return axis === 'width' ? { width: `${We}px` } : { height: `${We}px` }
}

function columnResizeMarginStyle(): Record<string, string> {
  const margin = Ke / 2
  return {
    marginLeft: `${margin}px`,
    marginRight: `${margin}px`,
  }
}

function metaGap(): string {
  return `${We + Ke}px`
}

function columnLetter(index: number): string {
  let n = index
  let s = ''
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return s
}

// --- Module-boundary drag (resize a module's height) ---
interface BoundaryDragState {
  columnIndex: number
  boundaryIndex: number
  startY: number
  targets: { columnIndex: number, moduleIndex: number, startHeight: number }[]
}

const boundaryDrag = ref<BoundaryDragState | null>(null)

function onBoundaryPointerDown(columnIndex: number, boundaryIndex: number, ev: PointerEvent) {
  const col = props.columns[columnIndex]
  if (!col || col.modules.length === 0) return
  ev.preventDefault()
  ev.stopPropagation()
  cancelBoundaryDrag()

  // Identify the module just below the boundary
  const adjacentIndex = boundaryIndex - 1
  if (boundaryIndex < 0 || boundaryIndex > col.modules.length) return
  const adjacentModule = col.modules[adjacentIndex]

  // Multi-target rule: if the adjacent module is in the selection AND multiple
  // modules are selected → drag heights for all selected modules. Otherwise
  // just the one adjacent module.
  let targets: { columnIndex: number, moduleIndex: number, startHeight: number }[]
  if (selectedSet.value.size > 1 && adjacentModule != null && selectedSet.value.has(adjacentModule.id)) {
    targets = []
    props.columns.forEach((c, ci) => {
      c.modules.forEach((m, mi) => {
        if (selectedSet.value.has(m.id)) {
          targets.push({ columnIndex: ci, moduleIndex: mi, startHeight: m.height })
        }
      })
    })
  }
  else if (adjacentModule != null) {
    targets = [{ columnIndex, moduleIndex: adjacentIndex, startHeight: adjacentModule.height }]
  }
  else {
    targets = []
  }

  boundaryDrag.value = {
    columnIndex,
    boundaryIndex,
    startY: ev.clientY,
    targets,
  }

  window.addEventListener('pointermove', onBoundaryPointerMove)
  window.addEventListener('pointerup', cancelBoundaryDrag)
  window.addEventListener('pointercancel', cancelBoundaryDrag)
}

function onBoundaryPointerMove(ev: PointerEvent) {
  const drag = boundaryDrag.value
  if (!drag) return
  const dy = ev.clientY - drag.startY
  // Negative dy → bigger module height (the boundary moved up).
  const deltaMeters = -dy / pxPerMeter.value
  for (const t of drag.targets) {
    emit('set-module-height', t.columnIndex, t.moduleIndex, t.startHeight + deltaMeters)
  }
}

function cancelBoundaryDrag() {
  boundaryDrag.value = null
  window.removeEventListener('pointermove', onBoundaryPointerMove)
  window.removeEventListener('pointerup', cancelBoundaryDrag)
  window.removeEventListener('pointercancel', cancelBoundaryDrag)
}

onBeforeUnmount(cancelBoundaryDrag)

// --- Click handlers ---
function onModuleClick(ev: MouseEvent, moduleId: string) {
  emit('toggle-module-selection', moduleId, ev.shiftKey)
}

function onColumnResizePointerDown(columnIndex: number, direction: 1 | -1, ev: PointerEvent) {
  emit('column-resize-start', columnIndex, direction, ev)
}

function columnTotalHeight(col: FurnitureColumn): number {
  return col.modules.reduce((sum, mod) => sum + mod.height, 0)
}

function columnRenderedHeight(col: FurnitureColumn): number {
  const moduleCount = col.modules.length
  const moduleHeight = meterToPx(columnTotalHeight(col))
  const spacerHeight = moduleCount > 0 ? We + moduleCount * zt : 0
  const gapHeight = moduleCount > 0 ? moduleCount * 2 * Ke : 0
  const height = moduleHeight + spacerHeight + gapHeight
  return height > 0 ? height + qt * 2 : 0
}

function boundaryHeight(boundaryIndex: number): number {
  const previous = props.columns[boundaryIndex - 1]
  const next = props.columns[boundaryIndex]
  return Math.max(previous ? columnRenderedHeight(previous) : 0, next ? columnRenderedHeight(next) : 0)
}

const railBodyHeight = computed<number>(() => {
  return props.columns.reduce((maxHeight, col) => Math.max(maxHeight, columnRenderedHeight(col)), 0) + Kl + Bt + meterToPx(legLift.value)
})

const railBodyHeightPx = computed<string>(() => `${railBodyHeight.value}px`)

function boundaryHeightPx(boundaryIndex: number): string {
  return `${boundaryHeight(boundaryIndex)}px`
}

function addButtonMarginTop(boundaryIndex: number): string {
  const adjacentHeight = boundaryHeight(boundaryIndex)
  const top = railBodyHeight.value - adjacentHeight / 2
  return `${Math.max(0, top - Vl / 2)}px`
}
</script>

<template>
  <div
    class="relative flex h-full min-w-0 flex-col overflow-hidden"
    data-v-b07ba140
    @click="emit('clear-module-selection')"
  >
    <div
      ref="viewportRef"
      class="h-full overflow-auto overscroll-contain"
    >
      <div class="flex min-h-full min-w-full items-center justify-center p-4 pb-32 sm:pb-44">
        <div class="flex w-max items-start justify-center gap-3">
          <button
            type="button"
            aria-label="Add column on the left"
            class="editor-touch-target flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-inverted shadow-sm transition-[opacity,transform] hover:opacity-90 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :style="columns.length > 0 ? { marginTop: addButtonMarginTop(0) } : undefined"
            @click.stop="emit('add-column-left')"
          >
            <UIcon
              name="i-lucide-plus"
              class="size-3.5"
            />
          </button>

          <div class="shrink-0 rounded-lg">
            <div
              class="flex w-max items-end"
              :style="{ height: railBodyHeightPx }"
            >
              <div
                v-if="columns.length > 0"
                class="column-resize-hit shrink-0 cursor-col-resize touch-none transition-opacity hover:opacity-75"
                :class="selectedFillClass"
                :style="{ ...spacerStyle('width'), ...columnResizeMarginStyle(), height: boundaryHeightPx(0), marginBottom: px(legLift), opacity: structure.leftSide ? undefined : 0.15 }"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize column 1"
                @pointerdown="onColumnResizePointerDown(0, -1, $event)"
              />

              <template
                v-for="(col, ci) in columns"
                :key="ci"
              >
                <div
                  class="flex h-full shrink-0 flex-col justify-end"
                  :style="{ width: px(col.width) }"
                >
                  <div
                    class="flex flex-col items-stretch"
                    :style="{ padding: `${qt}px` }"
                  >
                    <button
                      type="button"
                      class="editor-touch-target self-center flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-inverted shadow-sm transition-[opacity,transform] hover:opacity-90 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      :style="{ marginBottom: `${Bt}px` }"
                      :aria-label="`Add module on top of column ${ci + 1}`"
                      @click.stop="emit('add-module-top', ci)"
                    >
                      <UIcon
                        name="i-lucide-plus"
                        class="size-3.5"
                      />
                    </button>

                    <div
                      class="flex flex-col-reverse items-stretch"
                      :style="{ gap: `${Ke}px` }"
                      :aria-label="`Column ${ci + 1}, width ${formatMeasurement(col.width)} meters`"
                    >
                      <span
                        v-if="col.modules.length > 0"
                        class="block w-full shrink-0"
                        :class="[selectedFillClass, { invisible: !structure.bottom }]"
                        :style="spacerStyle('height')"
                        aria-hidden="true"
                      />

                      <template
                        v-for="(mod, mi) in col.modules"
                        :key="mod.id"
                      >
                        <button
                          type="button"
                          class="relative block w-full shrink-0 text-left outline-none transition-[opacity,transform,background-color] duration-150 hover:opacity-90 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-default"
                          :class="moduleClass(mod)"
                          :style="{ height: px(mod.height) }"
                          :aria-label="`${mod.type} module, height ${formatMeasurement(mod.height)} meters`"
                          @click.stop="onModuleClick($event, mod.id)"
                        >
                          <div
                            v-for="i in interiorShelfCount(mod)"
                            :key="`${mod.id}-shelf-${i}`"
                            class="pointer-events-none absolute inset-x-0 border-t border-current"
                            :class="mod.type === 'shelf' ? 'opacity-60' : 'border-dashed opacity-40'"
                            :style="{ bottom: `${i / (interiorShelfCount(mod) + 1) * 100}%` }"
                            aria-hidden="true"
                          />
                          <template v-if="mod.type === 'drawer'">
                            <div
                              v-for="i in drawerCount(mod) - 1"
                              :key="`${mod.id}-drawer-sep-${i}`"
                              class="absolute left-0 right-0 bg-[var(--ui-bg-muted)]"
                              :style="{ height: '2px', bottom: `${(i / drawerCount(mod)) * 100}%` }"
                              aria-hidden="true"
                            />
                            <template
                              v-for="i in drawerCount(mod)"
                              :key="`${mod.id}-dr-${i}`"
                            >
                              <div
                                class="absolute rounded-full"
                                :class="visualBgClass()"
                                :style="drawerPullStyle(mod, i, 'left')"
                              />
                              <div
                                class="absolute rounded-full"
                                :class="visualBgClass()"
                                :style="drawerPullStyle(mod, i, 'right')"
                              />
                            </template>
                          </template>

                          <div
                            v-else-if="mod.type === 'left-door'"
                            class="absolute rounded-full"
                            :class="visualBgClass()"
                            :style="leftDoorPullStyle()"
                          />

                          <div
                            v-else-if="mod.type === 'right-door'"
                            class="absolute rounded-full"
                            :class="visualBgClass()"
                            :style="rightDoorPullStyle()"
                          />

                          <template v-else-if="mod.type === 'doors'">
                            <div
                              class="absolute"
                              :class="visualBgClass()"
                              :style="doorDividerStyle()"
                            />
                            <div
                              class="absolute rounded-full"
                              :class="visualBgClass()"
                              :style="doorsPullStyle('left')"
                            />
                            <div
                              class="absolute rounded-full"
                              :class="visualBgClass()"
                              :style="doorsPullStyle('right')"
                            />
                          </template>
                        </button>

                        <button
                          type="button"
                          class="boundary-resize-hit relative block w-full shrink-0 cursor-row-resize"
                          :style="{ height: `${zt}px` }"
                          :aria-label="`Resize module boundary ${mi + 1} in column ${ci + 1}`"
                          @pointerdown="onBoundaryPointerDown(ci, mi + 1, $event)"
                        >
                          <span
                            class="absolute inset-x-0 top-1/2 -translate-y-1/2"
                            :class="[selectedFillClass, { invisible: mi === col.modules.length - 1 && !structure.top }]"
                            :style="spacerStyle('height')"
                          />
                        </button>
                      </template>
                    </div>
                  </div>
                  <ProjectFrontLegs :width="col.width" :config="config" :construction="structure" :pixels-per-meter="pxPerMeter" />
                </div>

                <div
                  class="column-resize-hit shrink-0 cursor-col-resize touch-none transition-opacity hover:opacity-75"
                  :class="selectedFillClass"
                  :style="{ ...spacerStyle('width'), ...columnResizeMarginStyle(), height: boundaryHeightPx(ci + 1), marginBottom: px(legLift), opacity: ci === columns.length - 1 && !structure.rightSide ? 0.15 : undefined }"
                  role="separator"
                  aria-orientation="vertical"
                  :aria-label="`Resize column ${ci + 1}`"
                  @pointerdown="onColumnResizePointerDown(ci, 1, $event)"
                />
              </template>

              <div
                v-if="columns.length === 0"
                class="flex h-full w-52 items-center justify-center text-sm text-muted"
              >
                No columns yet
              </div>
            </div>

            <div
              v-if="columns.length > 0"
              class="mt-2 flex w-max items-center border-t border-muted pt-2"
              :style="{ columnGap: metaGap(), paddingLeft: metaGap(), paddingRight: metaGap() }"
            >
              <div
                v-for="(col, ci) in columns"
                :key="`meta-${ci}`"
                class="flex shrink-0 flex-col items-center justify-start gap-2"
                :style="{ width: px(col.width) }"
              >
                <button
                  type="button"
                  class="editor-touch-target group relative inline-flex items-center text-xs text-muted transition-transform active:scale-[0.97]"
                  :aria-label="`Remove column ${columnLetter(ci)}`"
                  @click.stop="emit('remove-column', ci)"
                >
                  <span class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accented text-xs font-bold text-inverted transition-colors group-hover:bg-elevated">
                    <span class="group-hover:hidden">{{ columnLetter(ci) }}</span>
                    <UIcon
                      name="i-lucide-trash-2"
                      class="hidden size-3.5 group-hover:block"
                    />
                  </span>
                </button>
                <p class="text-xs font-semibold tabular-nums text-muted">
                  {{ formatMeasurement(col.width) }} m
                </p>
              </div>
            </div>
          </div>

          <button
            type="button"
            aria-label="Add column on the right"
            class="editor-touch-target flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-inverted shadow-sm transition-[opacity,transform] hover:opacity-90 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :style="columns.length > 0 ? { marginTop: addButtonMarginTop(columns.length) } : undefined"
            @click.stop="emit('add-column-right')"
          >
            <UIcon
              name="i-lucide-plus"
              class="size-3.5"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.module-shelf {
  background-color: transparent;
  border: 1px solid var(--ui-primary);
}
.module-shelf-dim {
  background-image: none;
  border-color: var(--ui-border-muted);
}
.module-shelf-selected,
.module-shelf:hover {
  background-image: repeating-linear-gradient(
    135deg,
    var(--ui-primary) 0,
    var(--ui-primary) 6px,
    transparent 6px,
    transparent 12px
  );
}
.module-shelf-dim:hover {
  background-image: repeating-linear-gradient(
    135deg,
    var(--ui-border-muted),
    var(--ui-border-muted) 6px,
    transparent 0,
    transparent 12px
  );
}
.editor-touch-target,
.column-resize-hit,
.boundary-resize-hit {
  position: relative;
}
.editor-touch-target::after {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 9999px;
}
.column-resize-hit::after {
  content: "";
  position: absolute;
  inset: 0 -10px;
}
.boundary-resize-hit::after {
  content: "";
  position: absolute;
  inset: -10px 0;
}
</style>
