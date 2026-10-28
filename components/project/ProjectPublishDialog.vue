<script setup lang="ts">
import * as Y from 'yjs'
import type { CloudProjectRecord, FurnitureColumn, FurnitureConfig, FurnitureConstruction, LocalProjectRow, PublicStyle } from '~~/shared/domain/types'
import { normalizePublicStyle } from '~~/shared/domain/defaults'
import { isRenderMessage, RENDER_MESSAGES } from '~~/shared/render/messages'
import { ensureInitialized, readFurnitureDoc } from '~~/shared/yjs/doc'

interface Props {
  open: boolean
  project: LocalProjectRow
  cloudRecord?: CloudProjectRecord | null
  publishedCloudRecord?: CloudProjectRecord | null
  publicStyle?: PublicStyle | null
}

const props = withDefaults(defineProps<Props>(), {
  cloudRecord: null,
  publishedCloudRecord: null,
  publicStyle: null,
})

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'published', record: CloudProjectRecord): void
  (e: 'unpublished'): void
}>()

const RENDER_VIDEO_SIZE_PX = 480
const RENDER_FPS = 24
const RENDER_DURATION_SECONDS = 3
const AUTO_RENDER_DELAY_MS = 300
const COPIED_FEEDBACK_MS = 2000

const open = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})
const runtimeConfig = useRuntimeConfig()
const { publishFromLocal, unpublishCloudProject } = useCloudProjects()
const { getDesignSnapshot } = useLocalProjects()

const publishing = ref(false)
const unpublishing = ref(false)
const confirmUnpublishOpen = ref(false)
const errorMessage = ref('')
const copiedFlash = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const cloudRecord = computed(() => props.publishedCloudRecord ?? props.cloudRecord ?? null)
const isPublished = computed(() => {
  const record = cloudRecord.value
  return !!record?.id && record.visibility === 'public' && typeof record.snapshot === 'string' && record.snapshot.length > 0
})
const publicShareUrl = computed(() => {
  const record = cloudRecord.value
  if (!isPublished.value || !record?.id || !import.meta.client) return ''
  const configuredOrigin = String(runtimeConfig.public.appBaseUrl || '').replace(/\/+$/, '')
  const origin = configuredOrigin || window.location.origin
  return `${origin}/p/${record.id}`
})
const hasPublicShareUrl = computed(() => publicShareUrl.value.length > 0)
const title = computed(() => isPublished.value ? 'Published project' : 'Publish project')
const description = computed(() =>
  isPublished.value
    ? 'Share the link below. Your cloud draft is what viewers see; autosync keeps it up to date.'
    : 'Make this project public. The share link shows your current cloud design; edits sync to the published view.',
)
const mp4ActionLabel = computed(() => {
  if (previewVideoUrl.value) return 'Download MP4'
  if (isRendering.value) return 'Generating MP4'
  if (renderError.value) return 'Retry MP4'
  return 'Generate MP4'
})
const mp4ActionIcon = computed(() => previewVideoUrl.value ? 'i-lucide-download' : 'i-lucide-video')

const normalizedPublicStyle = computed(() => normalizePublicStyle(props.publicStyle))
const renderStyleFingerprint = computed(() => JSON.stringify(normalizedPublicStyle.value))
const iframeSrc = ref<string | null>(null)
const iframeKey = ref(0)
const activeRenderId = ref('')
const renderIframeRef = ref<HTMLIFrameElement | null>(null)
const isRendering = ref(false)
const renderError = ref('')
const previewVideoBlob = ref<Blob | null>(null)
const previewVideoUrl = ref<string | null>(null)
const previewColumns = shallowRef<FurnitureColumn[]>([])
const previewConfig = shallowRef<FurnitureConfig | null>(null)
const previewConstruction = shallowRef<FurnitureConstruction | null>(null)
const previewLoading = ref(false)
let previewLoadSeq = 0
let renderStartTimer: ReturnType<typeof setTimeout> | undefined
let renderSeq = 0
let renderedFingerprint = ''

const renderFingerprint = computed(() => {
  const record = cloudRecord.value
  return [
    props.project.id,
    record?.id ?? '',
    record?.snapshot ?? '',
    record?.updated ?? '',
    renderStyleFingerprint.value,
  ].join('|')
})

function clearRenderStartTimer() {
  if (renderStartTimer === undefined) return
  clearTimeout(renderStartTimer)
  renderStartTimer = undefined
}

function resetVideoPreview(clearCompleted = true) {
  clearRenderStartTimer()
  if (previewVideoUrl.value) URL.revokeObjectURL(previewVideoUrl.value)
  previewVideoUrl.value = null
  previewVideoBlob.value = null
  iframeSrc.value = null
  activeRenderId.value = ''
  renderIframeRef.value = null
  isRendering.value = false
  renderError.value = ''
  if (clearCompleted) renderedFingerprint = ''
}

function resetStillPreview() {
  previewLoadSeq += 1
  previewColumns.value = []
  previewConfig.value = null
  previewConstruction.value = null
  previewLoading.value = false
}

async function loadStillPreview() {
  const seq = ++previewLoadSeq
  previewLoading.value = true
  try {
    const bytes = await getDesignSnapshot(props.project.id)
    if (seq !== previewLoadSeq) return
    if (!bytes || bytes.byteLength === 0) {
      previewColumns.value = []
      previewConfig.value = null
      previewConstruction.value = null
      return
    }
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, bytes)
      ensureInitialized(doc)
      const data = readFurnitureDoc(doc)
      if (seq !== previewLoadSeq) return
      previewColumns.value = data.columns
      previewConfig.value = data.config
      previewConstruction.value = data.construction ?? null
    }
    finally {
      doc.destroy()
    }
  }
  catch {
    if (seq === previewLoadSeq) {
      previewColumns.value = []
      previewConfig.value = null
      previewConstruction.value = null
    }
  }
  finally {
    if (seq === previewLoadSeq) previewLoading.value = false
  }
}

function startPreviewRender() {
  if (!open.value || !isPublished.value || isRendering.value) return
  const fingerprint = renderFingerprint.value
  if (previewVideoUrl.value && renderedFingerprint === fingerprint) return
  clearRenderStartTimer()
  if (previewVideoUrl.value) URL.revokeObjectURL(previewVideoUrl.value)
  previewVideoUrl.value = null
  previewVideoBlob.value = null
  renderError.value = ''
  isRendering.value = true
  iframeKey.value += 1
  activeRenderId.value = `${Date.now().toString(36)}-${(++renderSeq).toString(36)}`
  iframeSrc.value = `/render/project/${encodeURIComponent(props.project.id)}?size=${RENDER_VIDEO_SIZE_PX}&fps=${RENDER_FPS}&duration=${RENDER_DURATION_SECONDS}&renderId=${encodeURIComponent(activeRenderId.value)}&style=${encodeURIComponent(renderStyleFingerprint.value)}`
}

function schedulePreviewRender() {
  if (!open.value || !isPublished.value || isRendering.value) return
  if (previewVideoUrl.value && renderedFingerprint === renderFingerprint.value) return
  clearRenderStartTimer()
  renderStartTimer = setTimeout(() => {
    renderStartTimer = undefined
    startPreviewRender()
  }, AUTO_RENDER_DELAY_MS)
}

function safeFileName(name: string): string {
  const clean = name.trim().replace(/[^\w-]+/g, '_')
  return clean.length > 0 ? clean.slice(0, 80) : 'project'
}

function downloadPreview() {
  if (!previewVideoBlob.value) return
  const url = URL.createObjectURL(previewVideoBlob.value)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeFileName(props.project.name)}-480.mp4`
  a.rel = 'noopener'
  a.click()
  URL.revokeObjectURL(url)
}

function onPreviewVideoAction() {
  if (previewVideoUrl.value) {
    downloadPreview()
    return
  }
  startPreviewRender()
}

function onWindowMessage(ev: MessageEvent) {
  if (!import.meta.client) return
  if (ev.origin !== window.location.origin) return
  if (ev.source !== renderIframeRef.value?.contentWindow) return
  if (!isRenderMessage(ev.data)) return
  if (ev.data.renderId !== activeRenderId.value) return
  if (ev.data.type === RENDER_MESSAGES.READY || ev.data.type === RENDER_MESSAGES.PROGRESS) return

  if (ev.data.type === RENDER_MESSAGES.ERROR) {
    renderError.value = ev.data.message
    isRendering.value = false
    iframeSrc.value = null
    activeRenderId.value = ''
    renderIframeRef.value = null
    return
  }
  if (ev.data.type === RENDER_MESSAGES.DONE) {
    const blob = new Blob([ev.data.buffer], { type: 'video/mp4' })
    previewVideoBlob.value = blob
    if (previewVideoUrl.value) URL.revokeObjectURL(previewVideoUrl.value)
    previewVideoUrl.value = URL.createObjectURL(blob)
    renderedFingerprint = renderFingerprint.value
    isRendering.value = false
    iframeSrc.value = null
    activeRenderId.value = ''
    renderIframeRef.value = null
  }
}

watch(open, async (next) => {
  if (next) {
    errorMessage.value = ''
    copiedFlash.value = false
    resetVideoPreview()
    await nextTick()
    await loadStillPreview()
    schedulePreviewRender()
  }
  else {
    resetVideoPreview()
    resetStillPreview()
  }
})

watch(() => props.project.id, async () => {
  if (!open.value) return
  resetVideoPreview()
  await nextTick()
  await loadStillPreview()
  schedulePreviewRender()
})

watch(isPublished, async (next) => {
  if (!open.value || !next) return
  resetVideoPreview()
  await nextTick()
  await loadStillPreview()
  schedulePreviewRender()
})

watch(renderStyleFingerprint, () => {
  if (!open.value) return
  resetVideoPreview()
  schedulePreviewRender()
})

onMounted(() => {
  if (import.meta.client) window.addEventListener('message', onWindowMessage)
})

onBeforeUnmount(() => {
  if (import.meta.client) window.removeEventListener('message', onWindowMessage)
  if (copiedTimer !== undefined) clearTimeout(copiedTimer)
  resetVideoPreview()
  resetStillPreview()
})

async function publishProject() {
  if (isPublished.value) return
  errorMessage.value = ''
  publishing.value = true
  try {
    const published = await publishFromLocal(props.project, normalizedPublicStyle.value)
    emit('published', published)
    await nextTick()
    await loadStillPreview()
    schedulePreviewRender()
  }
  catch (err: unknown) {
    errorMessage.value = (err as { message?: string } | null)?.message ?? 'Publish failed.'
  }
  finally {
    publishing.value = false
  }
}

async function copyPublicLink() {
  const url = publicShareUrl.value
  if (!url || !navigator.clipboard?.writeText) return
  await navigator.clipboard.writeText(url)
  if (copiedTimer !== undefined) clearTimeout(copiedTimer)
  copiedFlash.value = true
  copiedTimer = setTimeout(() => {
    copiedFlash.value = false
    copiedTimer = undefined
  }, COPIED_FEEDBACK_MS)
}

async function unpublishProject() {
  const record = cloudRecord.value
  if (!record?.id) return
  errorMessage.value = ''
  unpublishing.value = true
  try {
    await unpublishCloudProject(record.id)
    confirmUnpublishOpen.value = false
    open.value = false
    emit('unpublished')
  }
  catch (err: unknown) {
    errorMessage.value = (err as { message?: string } | null)?.message ?? 'Unpublish failed.'
  }
  finally {
    unpublishing.value = false
  }
}
</script>

<template>
  <AppDialog
    v-model:open="open"
    :title="title"
    :description="description"
  >
    <template #prependBody>
      <div
        v-if="isPublished"
        class="flex flex-col items-center gap-3"
      >
        <div class="relative aspect-square w-full max-w-[min(100%,20rem)] overflow-hidden rounded-xl bg-muted shadow-md ring-1 ring-default/60">
          <video
            v-if="previewVideoUrl"
            :src="previewVideoUrl"
            class="size-full bg-black object-contain"
            muted
            loop
            autoplay
            playsinline
          />
          <ProjectPreview
            v-else
            :columns="previewColumns"
            :furniture-config="previewConfig"
            :construction="previewConstruction"
            class="size-full rounded-none border-0 ring-0"
          />
          <div
            v-if="isRendering"
            class="absolute inset-0 flex items-center justify-center bg-default/70 backdrop-blur-sm"
          >
            <UIcon
              name="i-lucide-loader-circle"
              class="size-10 animate-spin text-muted"
            />
          </div>
          <div
            v-else-if="previewLoading"
            class="absolute inset-0 flex items-center justify-center bg-muted px-3 text-center text-pretty text-xs text-muted"
          >
            Loading preview...
          </div>
        </div>
        <UButton
          :icon="mp4ActionIcon"
          :label="mp4ActionLabel"
          color="neutral"
          variant="outline"
          class="w-full min-h-10 max-w-[min(100%,20rem)] justify-center transition-transform active:scale-[0.97]"
          :loading="isRendering"
          :disabled="isRendering"
          @click="onPreviewVideoAction"
        />
        <UAlert
          v-if="renderError"
          color="error"
          variant="soft"
          :title="renderError"
        />
      </div>
    </template>

    <div class="flex flex-col gap-3">
      <UAlert
        v-if="errorMessage"
        color="error"
        variant="soft"
        :title="errorMessage"
      />

      <template v-if="hasPublicShareUrl">
        <UAlert
          color="success"
          variant="soft"
          title="Published"
          :description="publicShareUrl"
        />
        <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <UButton
            :icon="copiedFlash ? 'i-lucide-square-check' : 'i-lucide-copy'"
            :label="copiedFlash ? 'Copied' : 'Copy public link'"
            color="neutral"
            variant="soft"
            class="w-full min-h-10 min-w-0 justify-center transition-transform active:scale-[0.97] sm:flex-1"
            @click="copyPublicLink"
          />
          <UButton
            icon="i-lucide-eye-off"
            label="Unpublish"
            color="neutral"
            variant="outline"
            class="w-full min-h-10 min-w-0 justify-center transition-transform active:scale-[0.97] sm:flex-1"
            @click="confirmUnpublishOpen = true"
          />
        </div>
      </template>
    </div>

    <template #footer="{ close }">
      <div
        class="grid w-full gap-2"
        :class="isPublished ? 'grid-cols-1' : 'grid-cols-2'"
      >
        <UButton
          label="Close"
          color="neutral"
          variant="outline"
          class="w-full min-h-10 min-w-0 justify-center transition-transform active:scale-[0.97]"
          :disabled="publishing || unpublishing"
          @click="close()"
        />
        <UButton
          v-if="!isPublished"
          label="Publish"
          class="w-full min-h-10 min-w-0 justify-center transition-transform active:scale-[0.97]"
          :loading="publishing"
          :disabled="unpublishing"
          @click="publishProject"
        />
      </div>
    </template>
  </AppDialog>

  <iframe
    v-if="iframeSrc"
    :key="iframeKey"
    ref="renderIframeRef"
    :src="iframeSrc"
    :width="RENDER_VIDEO_SIZE_PX"
    :height="RENDER_VIDEO_SIZE_PX"
    title="Morti video render"
    class="pointer-events-none fixed left-[-9999px] top-0 border-0 opacity-0"
  />

  <AppConfirmDialog
    v-model:open="confirmUnpublishOpen"
    title="Unpublish project?"
    message="The public link will stop working until you publish again."
    cancel-label="Cancel"
    confirm-label="Unpublish"
    confirm-color="error"
    @confirm="unpublishProject"
  />
</template>
