<script setup lang="ts">
import type { FurnitureConfig, FurnitureConstruction } from '~~/shared/domain/types'
import { constructionBodyLift, legCenters } from '~~/shared/domain/construction'
const props = defineProps<{ width: number, config: FurnitureConfig, construction: FurnitureConstruction, pixelsPerMeter: number }>()
const positions = computed(() => legCenters(props.width, props.config.depth, props.config, props.construction).x)
</script>

<template>
  <div v-if="construction.legs.enabled" class="relative w-full shrink-0" :style="{ height: `${constructionBodyLift(construction, config) * pixelsPerMeter}px` }" aria-label="Patas del mueble">
    <span
      v-for="(x, i) in positions"
      :key="i"
      class="absolute bottom-0 block bg-primary"
      :style="{
        left: `${(width / 2 + x - construction.legs.width / 2) * pixelsPerMeter}px`,
        width: `${Math.max(2, construction.legs.width * pixelsPerMeter)}px`,
        height: `${construction.legs.height * pixelsPerMeter}px`,
      }"
    />
  </div>
</template>
