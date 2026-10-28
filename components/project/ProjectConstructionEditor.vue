<script setup lang="ts">
import type * as Y from 'yjs'
import ProjectConstructionPanel from './ProjectConstructionPanel.vue'
import { normalizeConstruction } from '~~/shared/domain/construction'
import { validateFurnitureDocIssues } from '~~/shared/domain/assembly-validation'
import { readFurnitureDoc, updateConstruction, setConfigValue, setExteriorDimensions } from '~~/shared/yjs/doc'
import { assemblyBounds, resolveFurnitureDimensions } from '~~/shared/domain/dimensions'

const props = defineProps<{ ydoc: Y.Doc }>()
const snapshot = shallowRef(readFurnitureDoc(props.ydoc))
const construction = computed(() => normalizeConstruction(snapshot.value.construction))
const issues = computed(() => validateFurnitureDocIssues(snapshot.value))
const actualDimensions = computed(() => {
  const bounds = assemblyBounds(resolveFurnitureDimensions(snapshot.value).assembly.panels)
  return bounds ? { width: bounds.width, height: bounds.height, depth: bounds.depth } : null
})

function refreshSnapshot() {
  snapshot.value = readFurnitureDoc(props.ydoc)
}

watch(() => props.ydoc, (next, previous) => {
  previous?.off('update', refreshSnapshot)
  next.on('update', refreshSnapshot)
  refreshSnapshot()
}, { immediate: true })

onScopeDispose(() => props.ydoc.off('update', refreshSnapshot))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-muted p-3 md:pt-[4.75rem]">
    <ProjectConstructionPanel
      :construction="construction"
      :config="snapshot.config"
      :columns="snapshot.columns"
      :issues="issues"
      :exterior="snapshot.exterior"
      :actual-dimensions="actualDimensions"
      @update="patch => updateConstruction(props.ydoc, patch)"
      @thickness="(key, value) => setConfigValue(props.ydoc, key, value)"
      @depth="value => setConfigValue(props.ydoc, 'depth', value)"
      @exterior="value => setExteriorDimensions(props.ydoc, value)"
    />
  </div>
</template>
