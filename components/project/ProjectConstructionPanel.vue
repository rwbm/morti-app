<script setup lang="ts">
import type { ConstructionPatch, FurnitureColumn, FurnitureConfig, FurnitureConstruction, ExteriorDimensions } from '~~/shared/domain/types'
import { LEG_METRIC_LIMITS } from '~~/shared/domain/construction'
import { formatMillimetres } from '~~/shared/domain/units'
import { buildCellGrid } from '~~/shared/domain/layout'
import { THICKNESS_FIELDS, type ThicknessKey } from '~~/shared/domain/thickness'

const props = defineProps<{
  construction: FurnitureConstruction
  config: FurnitureConfig
  columns: FurnitureColumn[]
  exterior?: ExteriorDimensions
  actualDimensions: ExteriorDimensions | null
  issues: { message: string, code: string, severity?: 'warning' | 'error' }[]
}>()
const emit = defineEmits<{
  (e: 'exterior', value: ExteriorDimensions | null): void
  (e: 'update', patch: ConstructionPatch): void
  (e: 'thickness', key: ThicknessKey, value: number): void
}>()
const parts = [
  { key: 'leftSide', label: 'Lateral izquierdo' },
  { key: 'rightSide', label: 'Lateral derecho' },
  { key: 'top', label: 'Tapa superior' },
  { key: 'bottom', label: 'Piso' },
  { key: 'back', label: 'Fondo' },
] as const
const legFields = [
  { key: 'height', label: 'Alto de las patas' },
  { key: 'width', label: 'Sección cuadrada' },
  { key: 'inset', label: 'Retiro desde el borde del piso' },
] as const
const dimensionFields = [
  { key: 'width', label: 'Ancho total' },
  { key: 'height', label: 'Alto total' },
  { key: 'depth', label: 'Profundidad total' },
] as const
const usefulWidths = computed(() => buildCellGrid(props.columns, props.config, props.construction).map(cells => cells[0]?.width ?? 0))

function toggleExterior(event: Event) {
  if (!(event.target as HTMLInputElement).checked) emit('exterior', null)
  else if (props.actualDimensions) emit('exterior', { ...props.actualDimensions })
}

function commitExterior(key: keyof ExteriorDimensions, event: Event) {
  const input = event.target as HTMLInputElement
  const mm = input.value.trim() === '' ? NaN : Number(input.value.replace(',', '.'))
  if (!props.exterior) return
  if (!Number.isFinite(mm) || mm < 1 || mm > 20000) {
    input.value = formatMillimetres(props.exterior[key])
    return
  }
  const value = Math.round(mm * 1000) / 1e6
  emit('exterior', { ...props.exterior, [key]: value })
  input.value = formatMillimetres(value)
}

function changeTopMode(event: Event) {
  emit('update', { topMode: (event.target as HTMLSelectElement).value as FurnitureConstruction['topMode'] })
}

function commitTopOverhang(event: Event) {
  const input = event.target as HTMLInputElement
  const mm = input.value.trim() === '' ? NaN : Number(input.value.replace(',', '.'))
  if (!Number.isFinite(mm) || mm < 0 || mm > 200) {
    input.value = formatMillimetres(props.construction.topOverhang)
    return
  }
  emit('update', { topOverhang: Math.round(mm) / 1000 })
}

function changePart(key: typeof parts[number]['key'], event: Event) {
  emit('update', { [key]: (event.target as HTMLInputElement).checked })
}

function changeLegs(event: Event) {
  emit('update', { legs: { enabled: (event.target as HTMLInputElement).checked } })
}

function commitThickness(key: ThicknessKey, event: Event) {
  const input = event.target as HTMLInputElement
  const mm = input.value.trim() === '' ? NaN : Number(input.value.replace(',', '.'))
  if (!Number.isInteger(mm) || mm < 1 || mm > 100) {
    input.value = String(Math.round(props.config[key] * 1000))
    return
  }
  emit('thickness', key, mm / 1000)
  input.value = String(mm)
}

function commitLegMetric(key: typeof legFields[number]['key'], event: Event) {
  const input = event.target as HTMLInputElement
  const parsed = input.value.trim() === '' ? NaN : Number(input.value.replace(',', '.')) / 1000
  const limit = LEG_METRIC_LIMITS[key]
  if (!Number.isFinite(parsed) || parsed < limit.min || parsed > limit.max) {
    input.value = String(Math.round(props.construction.legs[key] * 1000))
    return
  }
  const value = Math.round(parsed * 1000) / 1000
  emit('update', { legs: { [key]: value } })
  input.value = String(Math.round(value * 1000))
}
</script>

<template>
  <section class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-4" aria-label="Estructura del mueble">
    <header class="mb-5 space-y-1">
      <h2 class="text-lg font-semibold text-highlighted">Estructura</h2>
      <p class="text-xs leading-relaxed text-muted">Elegí las piezas exteriores y el apoyo del mueble. Los cambios se guardan automáticamente.</p>
    </header>
    <div class="space-y-5">
        <fieldset class="space-y-3">
          <legend class="mb-2 text-sm font-semibold text-highlighted">Medidas del mueble</legend>
          <label class="flex items-center gap-3 text-sm">
            <input type="checkbox" :checked="!!exterior" :disabled="!columns.length && !exterior" class="size-4 accent-primary" @change="toggleExterior">
            Fijar medidas exteriores
          </label>
          <p v-if="!columns.length" class="text-xs text-muted">Agregá una columna para definir el tamaño exterior.</p>
          <template v-if="exterior">
            <label v-for="field in dimensionFields" :key="field.key" class="flex items-center justify-between gap-3 text-sm">
              <span>{{ field.label }}</span>
              <span class="flex items-center gap-2">
                <input :value="formatMillimetres(exterior[field.key])" type="text" inputmode="decimal" :aria-label="`${field.label} exterior en milímetros`" class="w-24 rounded-md bg-default px-2 py-1.5 text-right tabular-nums outline-none focus:ring-2 focus:ring-primary" @blur="commitExterior(field.key, $event)" @keydown.enter.prevent="commitExterior(field.key, $event)">
                <span class="text-xs text-muted">mm</span>
              </span>
            </label>
            <p class="text-xs text-muted">Incluye patas, frentes cerrados y el vuelo de la tapa. Cambiar espesores o apoyos conserva este tamaño y recalcula el interior.</p>
            <p class="text-xs text-muted">Las columnas y módulos se reparten proporcionalmente. Sus medidas en Diseño ajustan el reparto dentro del tamaño total.</p>
          </template>
          <p v-else class="text-xs text-muted">Modo nominal: las medidas de Diseño definen módulos entre ejes. El tamaño exterior depende de espesores, patas y tapa.</p>
          <p v-if="actualDimensions" class="rounded-md bg-default p-3 text-xs tabular-nums">Exterior calculado: <strong>{{ formatMillimetres(actualDimensions.width) }} × {{ formatMillimetres(actualDimensions.height) }} × {{ formatMillimetres(actualDimensions.depth) }} mm</strong><br>Ancho × alto × profundidad</p>
          <p v-if="exterior && usefulWidths.length" class="text-xs text-muted">Anchos útiles de columnas: {{ usefulWidths.map((width, i) => `${String.fromCharCode(65 + i)}: ${formatMillimetres(width)} mm`).join(' · ') }}</p>
        </fieldset>
        <fieldset class="space-y-3">
          <legend class="mb-2 text-sm font-semibold text-highlighted">Espesores de los tableros</legend>
          <label v-for="field in THICKNESS_FIELDS" :key="field.key" class="flex items-center justify-between gap-3 text-sm">
            <span>{{ field.label }}</span>
            <span class="flex shrink-0 items-center gap-2">
              <input
                :value="Math.round(config[field.key] * 1000)"
                type="text"
                inputmode="numeric"
                :aria-label="`Espesor de ${field.label.toLowerCase()} en milímetros`"
                class="w-16 rounded-md bg-default px-2 py-1.5 text-right tabular-nums outline-none focus:ring-2 focus:ring-primary"
                @blur="commitThickness(field.key, $event)"
                @keydown.enter.prevent="commitThickness(field.key, $event)"
              >
              <span class="text-xs text-muted">mm</span>
            </span>
          </label>
          <p class="text-xs text-muted">Cada grupo tiene su propio espesor. El 3D y el despiece se actualizan al cambiarlo. Valores enteros de 1 a 100 mm.</p>

        </fieldset>
        <fieldset class="space-y-2">
          <legend class="mb-2 text-sm font-semibold text-highlighted">Piezas exteriores</legend>
          <label v-for="part in parts" :key="part.key" class="flex cursor-pointer items-center gap-3 rounded-md bg-muted px-3 py-2 text-sm">
            <input type="checkbox" :checked="construction[part.key]" class="size-4 accent-primary" @change="changePart(part.key, $event)">
            {{ part.label }}
          </label>
          <p class="text-xs text-muted">Se aplica a todas las columnas. Las divisiones interiores se conservan.</p>
        </fieldset>

        <fieldset v-if="construction.top" class="space-y-3 border-t border-default pt-4">
          <legend class="text-sm font-semibold text-highlighted">Montaje de la tapa</legend>
          <select :value="construction.topMode" aria-label="Montaje de la tapa superior" class="w-full rounded-md bg-default p-2 text-sm text-highlighted outline-none focus:ring-2 focus:ring-primary" @change="changeTopMode">
            <option value="inset">Entre los laterales</option>
            <option value="overlay">Sobre los laterales</option>
            <option value="cap">Sobretapa adicional</option>
          </select>
          <p class="text-xs text-muted">Sobre los laterales reemplaza la tapa interior por una cubierta continua. La sobretapa conserva la tapa interior y agrega otra encima de la estructura.</p>
          <label v-if="construction.topMode !== 'inset'" class="flex items-center justify-between gap-3 text-sm">
            <span>Vuelo de la cubierta por lado</span>
            <span class="flex items-center gap-2"><input :value="formatMillimetres(construction.topOverhang)" type="text" inputmode="numeric" aria-label="Vuelo de la cubierta por lado en milímetros" class="w-16 rounded-md bg-default px-2 py-1.5 text-right outline-none focus:ring-2 focus:ring-primary" @blur="commitTopOverhang" @keydown.enter.prevent="commitTopOverhang"><span class="text-xs text-muted">mm</span></span>
          </label>
          <p class="text-xs text-muted">El espesor de la cubierta usa el valor de cuerpo y estantes.</p>
        </fieldset>

        <fieldset class="space-y-3 border-t border-default pt-4">
          <legend class="text-sm font-semibold text-highlighted">Apoyo</legend>
          <label class="flex cursor-pointer items-center gap-3 rounded-md bg-muted px-3 py-2 text-sm">
            <input type="checkbox" :checked="construction.legs.enabled" class="size-4 accent-primary" @change="changeLegs">
            Agregar patas
          </label>
          <template v-if="construction.legs.enabled">
            <p class="text-xs text-muted">Cuatro patas de sección cuadrada por columna, apoyadas bajo el piso.</p>
            <label v-for="field in legFields" :key="field.key" class="flex items-center justify-between gap-3 text-sm">
              <span>{{ field.label }}</span>
              <span class="flex shrink-0 items-center gap-2">
                <input
                  :value="Math.round(construction.legs[field.key] * 1000)"
                  type="text"
                  inputmode="decimal"
                  :aria-label="`${field.label} en milímetros`"
                  class="w-20 rounded-md bg-muted px-2 py-1.5 text-right tabular-nums outline-none focus:ring-2 focus:ring-primary"
                  @blur="commitLegMetric(field.key, $event)"
                  @keydown.enter.prevent="commitLegMetric(field.key, $event)"
                >
                <span class="text-xs text-muted">mm</span>
              </span>
            </label>
            <p class="text-xs text-muted">Alto: 40–500 mm. Sección: 20–120 mm. Retiro: 0–200 mm.</p>
          </template>
        </fieldset>

        <p class="text-xs text-muted">Las patas elevan el cuerpo sin cambiar el espacio interior. Su parte superior queda al ras de la cara inferior del piso.</p>
        <p v-for="(issue, index) in issues" :key="`${issue.code}:${index}`" role="alert" class="rounded-md p-3 text-sm" :class="issue.severity === 'warning' ? 'bg-warning/10 text-warning' : 'bg-error/10 text-error'">{{ issue.message }}</p>
    </div>
  </section>
</template>
