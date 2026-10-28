<script setup lang="ts">
import type * as Y from 'yjs'
import { compileAssembly } from '~~/shared/domain/assembly'
import { groupCutlistPanels, groupCutlistOperations, panelRoleLabel, orientationLabel } from '~~/shared/domain/cutlist'
import type { CutlistPanelGroup } from '~~/shared/domain/cutlist'
import { formatMillimetres } from '~~/shared/domain/units'
import { readFurnitureDoc } from '~~/shared/yjs/doc'

interface Props {
  ydoc: Y.Doc
  selectedDrawingKey?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  selectedDrawingKey: null,
})

const emit = defineEmits<{
  (e: 'update:selectedDrawingKey', value: string | null): void
}>()

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

const compiled = computed(() => compileAssembly(snapshot.value))
const panelGroups = computed(() => groupCutlistPanels(compiled.value.panels, compiled.value.operations))
const panelRows = computed(() => panelGroups.value.map(group => ({ ...group, role: group.representative.role })))
const operationRows = computed(() => groupCutlistOperations(panelGroups.value, compiled.value.operations))

function isSelectedRow(row: CutlistPanelGroup) {
  return props.selectedDrawingKey === row.key || props.selectedDrawingKey === row.groupId
}

watch([panelRows, () => props.selectedDrawingKey], ([rows]) => {
  const selected = props.selectedDrawingKey
  if (selected && !rows.some(row => row.key === selected || row.groupId === selected)) {
    emit('update:selectedDrawingKey', null)
  }
})

function selectPanel(row: CutlistPanelGroup) {
  emit('update:selectedDrawingKey', isSelectedRow(row) ? null : row.key)
}

function clearSelection() {
  emit('update:selectedDrawingKey', null)
}

function stop() {}
</script>

<template>
  <div
    class="min-h-0 overflow-auto space-y-6 pt-32 md:pt-20"
    @click="clearSelection"
  >
    <p v-for="issue in compiled.issues" :key="`${issue.code}:${issue.moduleId ?? issue.columnIndex ?? ''}`" role="alert" class="rounded-md bg-error/10 p-3 text-sm text-error">{{ issue.message }}</p>
    <p class="text-xs text-muted">Todas las medidas de este despiece están en milímetros (mm). Ancho × largo × espesor corresponden a cada pieza, no al tamaño exterior del mueble.</p>
    <section @click.stop="stop">
      <h2 class="mb-2 text-balance text-sm font-semibold text-highlighted">
        Piezas de corte
      </h2>
      <div class="-mx-1 max-w-full overflow-x-auto px-1">
      <table class="w-full min-w-[32rem] border-collapse text-xs">
        <thead>
          <tr class="bg-muted/60 text-left text-muted">
            <th
              scope="col"
              class="w-0 whitespace-nowrap border border-default px-1 py-1.5 font-medium"
            >
              <span class="sr-only">Código de pieza</span>
            </th>
            <th class="border border-default px-2 py-1.5 font-medium">Pieza</th>
            <th class="border border-default px-2 py-1.5 font-medium"> Orientación </th>
            <th class="border border-default px-2 py-1.5 font-medium">Ancho (mm)</th>
            <th class="border border-default px-2 py-1.5 font-medium"> Largo (mm) </th>
            <th class="border border-default px-2 py-1.5 font-medium"> Espesor (mm) </th>
            <th class="border border-default px-2 py-1.5 font-medium">Cant.</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in panelRows"
            :key="row.key"
            :class="['cursor-pointer transition-colors', isSelectedRow(row) ? 'bg-primary/15' : 'odd:bg-default even:bg-muted/20 hover:bg-muted/50']"
            role="button"
            tabindex="0"
            @click="selectPanel(row)"
            @keydown.enter.prevent="selectPanel(row)"
            @keydown.space.prevent="selectPanel(row)"
          >
            <td :class="['w-0 whitespace-nowrap border px-1 py-1.5 align-middle', isSelectedRow(row) ? 'border-primary/30' : 'border-default']">
              <span class="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[10px] font-bold leading-none tracking-tight tabular-nums text-highlighted">
                {{ row.groupId }}
              </span>
            </td>
            <td :class="['border px-2 py-1.5', isSelectedRow(row) ? 'border-primary/30 text-highlighted' : 'border-default text-highlighted']">
              {{ panelRoleLabel(row.role) }}
            </td>
            <td :class="['border px-2 py-1.5', isSelectedRow(row) ? 'border-primary/30 text-default' : 'border-default text-muted']">
              {{ orientationLabel(row.orientation) }}
            </td>
            <td :class="['border px-2 py-1.5 tabular-nums', isSelectedRow(row) ? 'border-primary/30 text-highlighted' : 'border-default text-highlighted']">
              {{ formatMillimetres(row.width) }}
            </td>
            <td :class="['border px-2 py-1.5 tabular-nums', isSelectedRow(row) ? 'border-primary/30 text-highlighted' : 'border-default text-highlighted']">
              {{ formatMillimetres(row.height) }}
            </td>
            <td :class="['border px-2 py-1.5 tabular-nums', isSelectedRow(row) ? 'border-primary/30 text-highlighted' : 'border-default text-highlighted']">
              {{ formatMillimetres(row.thickness) }}
            </td>
            <td :class="['border px-2 py-1.5 font-semibold tabular-nums', isSelectedRow(row) ? 'border-primary/30 text-highlighted' : 'border-default text-highlighted']">
              {{ row.quantity }}
            </td>
          </tr>
          <tr v-if="panelRows.length === 0">
            <td
              colspan="7"
              class="border border-default px-2 py-4 text-center text-muted"
            >
              Todavía no hay piezas
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </section>

    <section>
      <h2 class="mb-2 text-balance text-sm font-semibold text-highlighted">
        Mecanizados
      </h2>
      <p class="mb-2 text-xs text-muted">Centros X/Y medidos desde el centro de la pieza en sus ejes locales. Las cantidades corresponden al total del grupo de piezas.</p>
      <div class="-mx-1 max-w-full overflow-x-auto px-1">
      <table class="w-full min-w-[65rem] border-collapse text-xs">
        <thead>
          <tr class="bg-muted/60 text-left text-muted">
            <th class="border border-default px-2 py-1.5 font-medium"> Operación </th>
            <th class="border border-default px-2 py-1.5 font-medium"> Pieza destino </th>
            <th class="border border-default px-2 py-1.5 font-medium">Cara</th>
            <th class="border border-default px-2 py-1.5 font-medium"> Diámetro (mm) </th>
            <th class="border border-default px-2 py-1.5 font-medium">Profundidad (mm)</th>
            <th class="border border-default px-2 py-1.5 font-medium">Ancho (mm)</th>
            <th class="border border-default px-2 py-1.5 font-medium"> Largo (mm) </th>
            <th class="border border-default px-2 py-1.5 font-medium">Centro X (mm)</th>
            <th class="border border-default px-2 py-1.5 font-medium">Centro Y (mm)</th>
            <th class="border border-default px-2 py-1.5 font-medium">Giro (°)</th>
            <th class="border border-default px-2 py-1.5 font-medium"> Pasante </th>
            <th class="border border-default px-2 py-1.5 font-medium">Cant.</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in operationRows"
            :key="row.key"
            class="odd:bg-default even:bg-muted/20"
          >
            <td class="border border-default px-2 py-1.5 text-highlighted">{{ row.operationType === 'rail-cut' ? 'Ranura' : 'Perforación' }}</td>
            <td class="border border-default px-2 py-1.5 text-highlighted">{{ row.groupId }} · {{ panelRoleLabel(row.targetRole) }}</td>
            <td class="border border-default px-2 py-1.5 text-muted">{{ row.face === 'back' ? 'Posterior' : 'Anterior' }}</td>
            <td class="border border-default px-2 py-1.5 tabular-nums text-highlighted">{{ formatMillimetres(row.diameter) }}</td>
            <td class="border border-default px-2 py-1.5 tabular-nums text-highlighted">{{ formatMillimetres(row.depth) }}</td>
            <td class="border border-default px-2 py-1.5 tabular-nums text-highlighted">{{ formatMillimetres(row.width) }}</td>
            <td class="border border-default px-2 py-1.5 tabular-nums text-highlighted">{{ formatMillimetres(row.length) }}</td>
            <td class="border border-default px-2 py-1.5 tabular-nums text-highlighted">{{ formatMillimetres(row.x) }}</td>
            <td class="border border-default px-2 py-1.5 tabular-nums text-highlighted">{{ formatMillimetres(row.y) }}</td>
            <td class="border border-default px-2 py-1.5 tabular-nums text-highlighted">{{ row.rotation.toLocaleString('es-UY', { maximumFractionDigits: 3 }) }}</td>
            <td class="border border-default px-2 py-1.5 text-muted">{{ row.through ? 'Sí' : 'No' }}</td>
            <td class="border border-default px-2 py-1.5 font-semibold tabular-nums text-highlighted">{{ row.quantity }}</td>
          </tr>
          <tr v-if="operationRows.length === 0">
            <td
              colspan="12"
              class="border border-default px-2 py-4 text-center text-muted"
            >
              No hay mecanizados
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </section>
  </div>
</template>
