<script setup lang="ts">
import ProjectFrontLegs from './ProjectFrontLegs.vue'
import { DEFAULT_FURNITURE_CONFIG } from '~~/shared/domain/defaults'
import type { FurnitureColumn, FurnitureConfig, FurnitureModule, FurnitureConstruction } from '~~/shared/domain/types'
import { interiorShelfCount } from '~~/shared/domain/interior'
import { constructionBodyLift, normalizeConstruction } from '~~/shared/domain/construction'

interface Props {
  columns: FurnitureColumn[]
  furnitureConfig?: FurnitureConfig | null
  config?: FurnitureConfig | null
  construction?: FurnitureConstruction | null
}

const props = withDefaults(defineProps<Props>(), {
  furnitureConfig: null,
  config: null,
})

const PX_PER_M = 80
const OUTER_PADDING = 3
const MODULE_GAP = 3
const RAIL_SIZE = 2

const furnitureConfig = computed<FurnitureConfig>(() => props.furnitureConfig ?? props.config ?? DEFAULT_FURNITURE_CONFIG)
const structure = computed(() => normalizeConstruction(props.construction))
const legLift = computed(() => constructionBodyLift(structure.value, furnitureConfig.value))

function pxValue(metres: number): number {
  if (!Number.isFinite(metres) || metres <= 0) return 0
  return Math.round(metres * PX_PER_M)
}

function px(metres: number): string {
  return `${pxValue(metres)}px`
}

function columnTotalHeight(column: FurnitureColumn): number {
  return column.modules.reduce((sum, mod) => sum + mod.height, 0)
}

function columnRenderedHeight(column: FurnitureColumn): number {
  const moduleCount = column.modules.length
  const moduleHeight = pxValue(columnTotalHeight(column))
  const spacerHeight = moduleCount > 0 ? RAIL_SIZE * (moduleCount + 1) : 0
  const gapHeight = moduleCount > 0 ? moduleCount * 2 * MODULE_GAP : 0
  const height = moduleHeight + spacerHeight + gapHeight
  return height > 0 ? height + OUTER_PADDING * 2 : 0
}

const previewHeight = computed<string>(() => {
  const height = props.columns.reduce((maxHeight, column) => Math.max(maxHeight, columnRenderedHeight(column)), 0)
  return `${Math.max(48, height + pxValue(legLift.value))}px`
})

function boundaryHeightPx(boundaryIndex: number): string {
  const previous = props.columns[boundaryIndex - 1]
  const next = props.columns[boundaryIndex]
  return `${Math.max(previous ? columnRenderedHeight(previous) : 0, next ? columnRenderedHeight(next) : 0)}px`
}

function pullDiameterPx(): number {
  return Math.max(2, Math.round(furnitureConfig.value.pullHoleDiameter * PX_PER_M))
}

function pullEdgeInsetPx(): number {
  return Math.round(furnitureConfig.value.pullHoleEdgeInset * PX_PER_M)
}

function pullPairHalfGapPx(): number {
  return Math.round((furnitureConfig.value.pullHolePairGap / 2) * PX_PER_M)
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
  const offset = side === 'left' ? -pullPairHalfGapPx() : pullPairHalfGapPx()
  return {
    width: `${d}px`,
    height: `${d}px`,
    top: `${inset - r}px`,
    left: `calc(50% + ${offset - r}px)`,
  }
}

function doorSeamStyle(): Record<string, string> {
  return {
    width: `${Math.max(1, Math.round(furnitureConfig.value.panelThickness * PX_PER_M))}px`,
    left: '50%',
    top: '0',
    bottom: '0',
    transform: 'translateX(-50%)',
  }
}

function drawerPullStyle(mod: FurnitureModule, drawerIndex: number, side: 'left' | 'right'): Record<string, string> {
  const config = furnitureConfig.value
  const d = pullDiameterPx()
  const r = d / 2
  const drawerCount = mod.drawerCount ?? 1
  const topM = (drawerIndex / drawerCount) * mod.height
  const bottomM = ((drawerIndex - 1) / drawerCount) * mod.height
  let centreM = topM - config.pullHoleEdgeInset
  const minCentre = bottomM + config.pullHoleDiameter / 2
  const maxCentre = topM - config.pullHoleDiameter / 2
  if (centreM < minCentre) centreM = minCentre
  if (centreM > maxCentre) centreM = maxCentre
  const pct = (centreM / mod.height) * 100
  const offset = side === 'left' ? -pullPairHalfGapPx() : pullPairHalfGapPx()
  return {
    width: `${d}px`,
    height: `${d}px`,
    left: `calc(50% + ${offset - r}px)`,
    bottom: `calc(${pct}% - ${r}px)`,
  }
}

function moduleClass(mod: FurnitureModule): string {
  return mod.type === 'shelf' ? 'preview-shelf' : 'bg-primary'
}
</script>

<template>
  <div class="flex items-center justify-center overflow-hidden rounded-md bg-muted p-2 shadow-sm ring-1 ring-default/60 tabular-nums">
    <div
      v-if="columns.length > 0"
      class="flex w-max items-end justify-center"
      :style="{ height: previewHeight }"
    >
      <div
        class="shrink-0 bg-primary"
        :style="{ width: `${RAIL_SIZE}px`, height: boundaryHeightPx(0), marginBottom: px(legLift), opacity: structure.leftSide ? 1 : 0 }"
        aria-hidden="true"
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
            :style="{ padding: `${OUTER_PADDING}px` }"
          >
            <div
              class="flex flex-col-reverse items-stretch"
              :style="{ gap: `${MODULE_GAP}px` }"
            >
              <span
                :class="{ invisible: !structure.bottom }"
                class="block w-full shrink-0 bg-primary"
                :style="{ height: `${RAIL_SIZE}px` }"
                aria-hidden="true"
              />

              <template
                v-for="(mod, mi) in col.modules"
                :key="mod.id ?? mi"
              >
                <div
                  :class="['relative block w-full shrink-0', moduleClass(mod)]"
                  :style="{ height: px(mod.height) }"
                  :aria-label="`${mod.type} preview`"
                >
                  <div
                    v-for="i in interiorShelfCount(mod)"
                    :key="`${mod.id}-shelf-${i}`"
                    class="absolute inset-x-0 border-t border-current"
                    :class="mod.type === 'shelf' ? 'opacity-60' : 'border-dashed opacity-40'"
                    :style="{ bottom: `${i / (interiorShelfCount(mod) + 1) * 100}%` }"
                    aria-hidden="true"
                  />
                  <template v-if="mod.type === 'drawer'">
                    <div
                      v-for="i in (mod.drawerCount ?? 1) - 1"
                      :key="`${mod.id}-drawer-sep-${i}`"
                      class="absolute left-0 right-0 bg-[var(--ui-bg)]"
                      :style="{ height: '2px', bottom: `${(i / (mod.drawerCount ?? 1)) * 100}%` }"
                      aria-hidden="true"
                    />
                    <template
                      v-for="i in (mod.drawerCount ?? 1)"
                      :key="`${mod.id}-dr-${i}`"
                    >
                      <div
                        class="absolute rounded-full bg-[var(--ui-bg)]"
                        :style="drawerPullStyle(mod, i, 'left')"
                      />
                      <div
                        class="absolute rounded-full bg-[var(--ui-bg)]"
                        :style="drawerPullStyle(mod, i, 'right')"
                      />
                    </template>
                  </template>

                  <div
                    v-else-if="mod.type === 'left-door'"
                    class="absolute rounded-full bg-[var(--ui-bg)]"
                    :style="leftDoorPullStyle()"
                  />

                  <div
                    v-else-if="mod.type === 'right-door'"
                    class="absolute rounded-full bg-[var(--ui-bg)]"
                    :style="rightDoorPullStyle()"
                  />

                  <template v-else-if="mod.type === 'doors'">
                    <div
                      class="absolute bg-[var(--ui-bg)]"
                      :style="doorSeamStyle()"
                    />
                    <div
                      class="absolute rounded-full bg-[var(--ui-bg)]"
                      :style="doorsPullStyle('left')"
                    />
                    <div
                      class="absolute rounded-full bg-[var(--ui-bg)]"
                      :style="doorsPullStyle('right')"
                    />
                  </template>
                </div>

                <span
                  :class="{ invisible: mi === col.modules.length - 1 && !structure.top }"
                  class="block w-full shrink-0 bg-primary"
                  :style="{ height: `${RAIL_SIZE}px` }"
                  aria-hidden="true"
                />
              </template>
            </div>
          </div>
          <ProjectFrontLegs :width="col.width" :config="furnitureConfig" :construction="structure" :pixels-per-meter="PX_PER_M" />
        </div>

        <div
          class="shrink-0 bg-primary"
          :style="{ width: `${RAIL_SIZE}px`, height: boundaryHeightPx(ci + 1), marginBottom: px(legLift), opacity: ci === columns.length - 1 && !structure.rightSide ? 0 : 1 }"
          aria-hidden="true"
        />
      </template>
    </div>

    <div
      v-else
      class="flex h-full w-full items-center justify-center text-balance text-xs text-muted"
    >
      Empty project
    </div>
  </div>
</template>

<style scoped>
.preview-shelf {
  background-color: transparent;
  border: 1px solid var(--ui-primary);
}
</style>
