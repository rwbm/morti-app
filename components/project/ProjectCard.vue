<script setup lang="ts">
import type { FurnitureColumn, FurnitureConfig, FurnitureConstruction } from '~~/shared/domain/types'

interface CardProject {
  id: string
  name: string
  updatedAt: number | string
  pinned?: boolean
}

interface Props {
  project: CardProject
  to?: string
  previewColumns?: FurnitureColumn[]
  previewConfig?: FurnitureConfig | null
  previewConstruction?: FurnitureConstruction | null
  published?: boolean
  demo?: boolean
  adminActions?: boolean
  showActions?: boolean
  showDate?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  to: undefined,
  previewColumns: () => [],
  previewConfig: null,
  published: false,
  demo: false,
  adminActions: false,
  showActions: true,
  showDate: true,
})

const emit = defineEmits<{
  (e: 'rename', project: CardProject): void
  (e: 'delete', projectId: string): void
  (e: 'togglePin', projectId: string): void
  (e: 'duplicate', project: CardProject): void
  (e: 'toggleDemo', projectId: string): void
}>()

const { exportMortiFile } = useLocalProjects()

const isPinned = computed(() => props.project.pinned ?? false)
const projectTo = computed(() => props.to ?? `/project/${props.project.id}`)
const cardTitleId = computed(() => `project-card-title-${props.project.id}`)

const formattedDate = computed(() => {
  const date = new Date(props.project.updatedAt)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
})

async function exportProject() {
  if (!import.meta.client) return
  const blob = await exportMortiFile(props.project.id)
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(props.project.name.trim() || 'project').replace(/[<>:"/\\|?*]/g, '-')}.morti`
  a.rel = 'noopener'
  a.click()
  URL.revokeObjectURL(url)
}

const menuItems = computed(() => [
  { label: 'Change name', icon: 'i-lucide-text-cursor-input', onSelect: () => emit('rename', props.project) },
  { label: 'Export', icon: 'i-lucide-download', onSelect: () => { void exportProject() } },
  { label: 'Duplicate', icon: 'i-lucide-copy-plus', onSelect: () => emit('duplicate', props.project) },
  ...(props.adminActions
    ? [
        { type: 'separator' as const },
        {
          label: props.demo ? 'Remove from demos' : 'Set as demo',
          icon: props.demo ? 'i-lucide-circle-minus' : 'i-lucide-sparkles',
          onSelect: () => emit('toggleDemo', props.project.id),
        },
      ]
    : []),
  { type: 'separator' as const },
  { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => emit('delete', props.project.id) },
])
</script>

<template>
  <UCard
    :class="[
      'group/card relative cursor-pointer overflow-hidden',
      isPinned ? 'morti-card-pinned' : 'morti-card-presence',
    ]"
    :ui="{ body: 'relative p-4 sm:p-5' }"
  >
    <NuxtLink
      :to="projectTo"
      :prefetch="false"
      class="absolute inset-0 z-0 block rounded-[inherit] outline-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-inset after:ring-transparent after:transition-shadow after:duration-150 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-primary"
      :aria-labelledby="cardTitleId"
    />

    <div class="pointer-events-none relative z-10 flex flex-col gap-3">
      <div class="relative">
        <ProjectPreview
          :columns="previewColumns ?? []"
          :furniture-config="previewConfig"
          :construction="previewConstruction"
          class="aspect-square w-full"
        />
        <div
          v-if="published || demo"
          class="absolute right-2 top-2 flex flex-wrap justify-end gap-1"
        >
          <UBadge
            v-if="published"
            label="Published"
            color="neutral"
            variant="solid"
            size="sm"
            :ui="{ label: 'uppercase font-semibold tracking-[0.08em]' }"
            class="morti-badge-published"
          />
          <UBadge
            v-if="demo"
            label="Demo"
            color="neutral"
            variant="solid"
            size="sm"
            :ui="{ label: 'italic lowercase font-normal' }"
            class="morti-badge-demo"
          />
        </div>
      </div>

      <div class="pointer-events-auto flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <p
            v-if="showDate && formattedDate"
            class="mb-0.5 text-[11px] uppercase tracking-[0.08em] tabular-nums text-muted/80"
          >
            {{ formattedDate }}
          </p>
          <h2
            :id="cardTitleId"
            class="text-balance text-[17px] font-semibold leading-[1.25] tracking-[-0.012em] text-highlighted line-clamp-2 sm:text-[18px]"
          >
            {{ project.name }}
          </h2>
        </div>

        <div
          v-if="showActions"
          class="-mr-1 flex shrink-0 items-center gap-0.5"
          :class="showDate && formattedDate ? 'mt-[18px]' : 'mt-0.5'"
        >
          <UButton
            icon="i-lucide-pin"
            :color="isPinned ? 'primary' : 'neutral'"
            variant="ghost"
            size="xs"
            :class="[
              'text-muted transition-transform hover:text-highlighted active:scale-[0.97]',
              isPinned && 'text-highlighted ring-1 ring-[color:color-mix(in_oklch,var(--color-morti-400)_55%,transparent)]',
            ]"
            :aria-label="isPinned ? 'Unpin project' : 'Pin project'"
            :aria-pressed="isPinned"
            @click.stop.prevent="emit('togglePin', project.id)"
          />
          <UDropdownMenu
            :items="menuItems"
            :content="{ align: 'end' }"
            :modal="false"
          >
            <UButton
              icon="i-lucide-ellipsis-vertical"
              color="neutral"
              variant="ghost"
              size="xs"
              class="text-muted transition-transform hover:text-highlighted active:scale-[0.97]"
              aria-label="Project actions"
            />
          </UDropdownMenu>
        </div>
      </div>
    </div>
  </UCard>
</template>
