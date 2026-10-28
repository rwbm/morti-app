<script setup lang="ts">
import type { ConstructionPatch, FurnitureColumn, FurnitureConfig, FurnitureConstruction } from '~~/shared/domain/types'
import { constructionBodyLift, LEG_METRIC_LIMITS } from '~~/shared/domain/construction'
import { THICKNESS_FIELDS, type ThicknessKey } from '~~/shared/domain/thickness'

const props = defineProps<{
  construction: FurnitureConstruction
  config: FurnitureConfig
  columns: FurnitureColumn[]
  issues: { message: string, code: string }[]
}>()
const emit = defineEmits<{
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
const totalHeight = computed(() => {
  if (!props.columns.length) return '0'
  const height = Math.max(...props.columns.map(c => c.modules.reduce((sum, m) => sum + m.height, 0)))
    + 2 * props.config.sidePanelOverhang + constructionBodyLift(props.construction, props.config)
  return height.toLocaleString('es-UY', { maximumFractionDigits: 3 })
})

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
          <p class="text-xs text-muted">Por ahora se conservan las medidas nominales de los módulos; el tamaño exterior puede variar con el espesor del cuerpo.</p>
        </fieldset>
        <fieldset class="space-y-2">
          <legend class="mb-2 text-sm font-semibold text-highlighted">Piezas exteriores</legend>
          <label v-for="part in parts" :key="part.key" class="flex cursor-pointer items-center gap-3 rounded-md bg-muted px-3 py-2 text-sm">
            <input type="checkbox" :checked="construction[part.key]" class="size-4 accent-primary" @change="changePart(part.key, $event)">
            {{ part.label }}
          </label>
          <p class="text-xs text-muted">Se aplica a todas las columnas. Las divisiones interiores y las medidas de los módulos se conservan.</p>
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

        <p class="rounded-md bg-muted p-3 text-sm">Altura exterior aproximada: <strong>{{ totalHeight }} m</strong></p>
        <p class="text-xs text-muted">Las patas elevan el cuerpo sin cambiar el espacio interior. Su parte superior queda al ras de la cara inferior del piso.</p>
        <p v-for="issue in issues" :key="issue.code" role="alert" class="rounded-md bg-error/10 p-3 text-sm text-error">{{ issue.message }}</p>
    </div>
  </section>
</template>
