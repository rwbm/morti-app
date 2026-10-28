<script setup lang="ts">
import type { CameraState, CloudProjectRecord, LocalProjectRow, PublicStyle, ViewMode } from '~~/shared/domain/types'
import { DEFAULT_CAMERA_STATE, normalizePublicStyle } from '~~/shared/domain/defaults'
import { exportDoc } from '~~/shared/yjs/morti-format'

definePageMeta({ layout: false })

const LazyProjectCanvas = defineAsyncComponent(() => import('~/components/three/ProjectCanvas.vue'))
const LazyProjectDesigner = defineAsyncComponent(() => import('~/components/project/ProjectDesigner.vue'))
const LazyProjectConstructionEditor = defineAsyncComponent(() => import('~/components/project/ProjectConstructionEditor.vue'))
const LazyProjectCutlist = defineAsyncComponent(() => import('~/components/project/ProjectCutlist.vue'))
const LazyProjectCutlistPanelGrid = defineAsyncComponent(() => import('~/components/project/ProjectCutlistPanelGrid.vue'))
const LazyAppConfirmDialog = defineAsyncComponent(() => import('~/components/app/AppConfirmDialog.vue'))
const LazyAppFormDialog = defineAsyncComponent(() => import('~/components/app/AppFormDialog.vue'))

const route = useRoute()
const id = computed(() => String(route.params.id))

const runtimeConfig = useRuntimeConfig()
const styleTabFlag = computed<boolean>(
  () => runtimeConfig.public.features?.projectStyleTab === true,
)

const { user, isCloudAuthed, isVerified } = useAuth()
const {
  getLocalProject,
  renameLocalProject,
  deleteLocalProject,
  duplicateLocalProject,
} = useLocalProjects()
const {
  findCloudProjectByClientId,
  softDeleteCloudProjectForClientId,
  ensureCloudProject,
  updateCloudProjectStyle,
  updateCloudProjectDemoFlag,
} = useCloudProjects()

// --- Load local project + design doc ---
const project = ref<LocalProjectRow | null>(null)
const loading = ref(true)
const cloudRecord = ref<CloudProjectRecord | null>(null)
const CLOUD_RECORD_FRESH_MS = 4000
const cloudRecordMutatedAt = ref(0)

let designHandle: Awaited<ReturnType<typeof useDesignDoc>> | null = null
const docRef = shallowRef<unknown>(null)
const projectCanvasRef = ref<{ getExportRoot: () => unknown } | null>(null)
const exportingModel = ref(false)
const undoFn = ref<() => void>(() => {})
const redoFn = ref<() => void>(() => {})
const canUndo = ref(false)
const canRedo = ref(false)

let editorStateHandle: Awaited<ReturnType<typeof useEditorState>> | null = null
let undoFlagStop: ReturnType<typeof watchEffect> | null = null
let loadSeq = 0

// View mode + UI state — hydrated from editor state once it loads.
const viewMode = ref<ViewMode>('assembly')
const splitRatio = ref(0.55)
const mobileSplitRatio = ref(0.5)
const inputsCollapsed = ref(false)
const cameraState = ref<CameraState | null>(null)
const selectedModules = ref<{ id: string }[]>([])
const zoomPercent = ref(100)
const assemblyOpenDoorsDrawers = ref(false)
const assemblySpaceModulesView = ref(false)
const moduleVolumeHelpersVisible = ref(false)
const renderMode = ref<'rendered' | 'render-debug' | 'technical'>('render-debug')
const publicStyle = ref<PublicStyle>(normalizePublicStyle())
const cutlistSelectedDrawingKey = ref<string | null>(null)

const userNeedsEmailVerification = computed<boolean>(
  () => !!user.value?.id && !isVerified.value,
)
const isAdmin = computed<boolean>(() => user.value?.is_admin === true)
const isPublished = computed<boolean>(() =>
  !!cloudRecord.value?.id
  && cloudRecord.value.visibility === 'public'
  && typeof cloudRecord.value.snapshot === 'string'
  && cloudRecord.value.snapshot.length > 0,
)
const isDemo = computed<boolean>(() => cloudRecord.value?.is_demo === true)
const isEditingPublishedCopy = computed<boolean>(
  () => isCloudAuthed.value && !!project.value && isPublished.value,
)
const isMobileViewport = ref(false)
const MOBILE_ASSEMBLY_PREVIEW_RATIO = 0.5
const STYLE_DESKTOP_PREVIEW_RATIO = 0.76
let mobileViewportQuery: MediaQueryList | null = null

function updateMobileViewport() {
  isMobileViewport.value = mobileViewportQuery?.matches ?? false
}

const sidebarView = computed(() => viewMode.value === 'construction' || (styleTabFlag.value && viewMode.value === 'style'))

const collapseEditorInputs = computed<boolean>(
  () => inputsCollapsed.value && viewMode.value === 'assembly',
)
const activeSplitRatio = computed<number>(() => {
  if (viewMode.value === 'cutlist') return isMobileViewport.value ? 0.46 : 0.5
  if (sidebarView.value) return isMobileViewport.value ? mobileSplitRatio.value : STYLE_DESKTOP_PREVIEW_RATIO
  if (collapseEditorInputs.value) return 1
  return isMobileViewport.value ? mobileSplitRatio.value : splitRatio.value
})
const canvasRenderMode = computed<'rendered' | 'render-debug' | 'technical'>(() =>
  styleTabFlag.value && viewMode.value === 'style'
    ? publicStyle.value.renderStyle === 'technical' ? 'technical' : 'render-debug'
    : renderMode.value,
)
const selectedModuleIds = computed<string[]>(() => selectedModules.value.map(module => module.id))
const cutlistWipConfirmed = ref(false)
const CUTLIST_WIP_STORAGE_KEY = 'morti-cutlist-wip-alert-confirmed'

function cloneDefaultCameraState(): CameraState {
  return {
    position: [...DEFAULT_CAMERA_STATE.position] as [number, number, number],
    quaternion: [...DEFAULT_CAMERA_STATE.quaternion] as [number, number, number, number],
    target: [...DEFAULT_CAMERA_STATE.target] as [number, number, number],
  }
}

function coerceRenderMode(value: unknown): 'rendered' | 'render-debug' | 'technical' {
  if (value === 'technical') return 'technical'
  return 'render-debug'
}

function validNumberTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(v => typeof v === 'number' && Number.isFinite(v))
}

function hasValidQuaternion(quaternion: number[]): boolean {
  return quaternion.reduce((sum, n) => sum + n * n, 0) > 1e-10
}

function normalizeCameraState(value: unknown): CameraState {
  if (!value || typeof value !== 'object') return cloneDefaultCameraState()
  const camera = value as {
    position?: unknown
    quaternion?: unknown
    target?: unknown
  }
  if (validNumberTuple(camera.position, 3) && validNumberTuple(camera.quaternion, 4) && validNumberTuple(camera.target, 3)) {
    if (!hasValidQuaternion(camera.quaternion)) return cloneDefaultCameraState()
    return {
      position: [camera.position[0], camera.position[1], camera.position[2]],
      quaternion: [camera.quaternion[0], camera.quaternion[1], camera.quaternion[2], camera.quaternion[3]],
      target: [camera.target[0], camera.target[1], camera.target[2]],
    }
  }
  const pos = camera.position as { x?: unknown, y?: unknown, z?: unknown } | undefined
  const quat = camera.quaternion as { x?: unknown, y?: unknown, z?: unknown, w?: unknown } | undefined
  const target = camera.target as { x?: unknown, y?: unknown, z?: unknown } | undefined
  const nums = [pos?.x, pos?.y, pos?.z, quat?.x, quat?.y, quat?.z, quat?.w, target?.x, target?.y, target?.z]
  if (!nums.every(v => typeof v === 'number' && Number.isFinite(v))) return cloneDefaultCameraState()
  const quaternion = [quat!.x as number, quat!.y as number, quat!.z as number, quat!.w as number]
  if (!hasValidQuaternion(quaternion)) return cloneDefaultCameraState()
  return {
    position: [pos!.x as number, pos!.y as number, pos!.z as number],
    quaternion: quaternion as [number, number, number, number],
    target: [target!.x as number, target!.y as number, target!.z as number],
  }
}

function resetEditorUi() {
  cameraState.value = cloneDefaultCameraState()
  splitRatio.value = 0.55
  mobileSplitRatio.value = MOBILE_ASSEMBLY_PREVIEW_RATIO
  viewMode.value = 'assembly'
  inputsCollapsed.value = false
  selectedModules.value = []
  zoomPercent.value = 100
  assemblyOpenDoorsDrawers.value = false
  assemblySpaceModulesView.value = false
  moduleVolumeHelpersVisible.value = false
  renderMode.value = 'render-debug'
  publicStyle.value = normalizePublicStyle()
  cutlistSelectedDrawingKey.value = null
}

function disposeProjectHandles() {
  draftSyncStop?.()
  draftSyncStop = null
  autosync?.dispose()
  autosync = null
  draftSyncStatus.value = 'idle'
  undoFlagStop?.()
  undoFlagStop = null
  editorStateHandle?.dispose()
  editorStateHandle = null
  designHandle?.dispose()
  designHandle = null
  docRef.value = null
  undoFn.value = () => {}
  redoFn.value = () => {}
  canUndo.value = false
  canRedo.value = false
}

function applyEditorState(s: Awaited<ReturnType<typeof useEditorState>>['state']) {
  viewMode.value = s.viewMode === 'style' && !styleTabFlag.value ? 'assembly' : s.viewMode
  splitRatio.value = Number.isFinite(s.splitRatio) ? s.splitRatio : 0.55
  selectedModules.value = (s.selectedModuleIds ?? []).map(moduleId => ({ id: moduleId }))
  zoomPercent.value = s.projectDesignerZoomPercent ?? 100
  cameraState.value = normalizeCameraState(s.camera)
  assemblyOpenDoorsDrawers.value = s.assemblyOpenDoorsDrawers ?? false
  assemblySpaceModulesView.value = s.assemblySpaceModulesView ?? false
  if (assemblyOpenDoorsDrawers.value && assemblySpaceModulesView.value) assemblySpaceModulesView.value = false
  moduleVolumeHelpersVisible.value = s.moduleVolumeHelpersVisible ?? false
  renderMode.value = coerceRenderMode(s.renderMode)
  publicStyle.value = normalizePublicStyle(s.publicStyle)
  cutlistSelectedDrawingKey.value = typeof s.cutlistSelectedDrawingKey === 'string' && s.cutlistSelectedDrawingKey.length > 0 ? s.cutlistSelectedDrawingKey : null
}

async function loadProject(projectId: string) {
  const seq = ++loadSeq
  loading.value = true
  disposeProjectHandles()
  resetEditorUi()
  cloudRecord.value = null
  demoToggleError.value = ''
  deleteError.value = ''
  const local = await getLocalProject(projectId)
  if (seq !== loadSeq || projectId !== id.value) return
  project.value = local ?? null
  if (!local) {
    loading.value = false
    return
  }

  designHandle = await useDesignDoc(projectId)
  if (seq !== loadSeq || projectId !== id.value) {
    designHandle.dispose()
    designHandle = null
    return
  }
  docRef.value = designHandle.doc
  undoFn.value = designHandle.undo
  redoFn.value = designHandle.redo
  undoFlagStop = watchEffect(() => {
    canUndo.value = designHandle?.canUndo.value ?? false
    canRedo.value = designHandle?.canRedo.value ?? false
  })

  editorStateHandle = await useEditorState(projectId)
  if (seq !== loadSeq || projectId !== id.value) {
    editorStateHandle.dispose()
    editorStateHandle = null
    return
  }
  applyEditorState(editorStateHandle.state)

  loading.value = false
}

// Bootstrap.
onMounted(async () => {
  if (import.meta.client) {
    window.addEventListener('keydown', onKeydown)
    mobileViewportQuery = window.matchMedia('(max-width: 767.98px)')
    updateMobileViewport()
    mobileViewportQuery.addEventListener('change', updateMobileViewport)
  }
  if (import.meta.client) cutlistWipConfirmed.value = localStorage.getItem(CUTLIST_WIP_STORAGE_KEY) === 'true'
  await loadProject(id.value)
})

watch(id, (projectId) => { void loadProject(projectId) })

async function refreshCloudRecord() {
  if (!isCloudAuthed.value || !project.value) {
    cloudRecord.value = null
    return
  }
  try {
    const record = await findCloudProjectByClientId(project.value.id)
    const freshLocalMutation = Date.now() - cloudRecordMutatedAt.value < CLOUD_RECORD_FRESH_MS
    if (
      freshLocalMutation
      && cloudRecord.value
      && (!record || record.id !== cloudRecord.value.id || record.visibility !== cloudRecord.value.visibility)
    ) {
      return
    }
    cloudRecord.value = record
  }
  catch {
    // Local-only mode: keep the editor usable when the cloud backend is unavailable.
  }
}

watch(
  [() => user.value?.id, isVerified, () => project.value?.id],
  () => { void refreshCloudRecord() },
  { immediate: true },
)

// --- Cloud autosync (lazy attached once doc + project are known) ---
let autosync: ReturnType<typeof useCloudAutosync> | null = null
let draftSyncStop: ReturnType<typeof watchEffect> | null = null
const draftSyncStatus = ref<'idle' | 'syncing' | 'synced' | 'offline' | 'error'>('idle')
watchEffect(() => {
  if (autosync || !docRef.value || !designHandle || !project.value) return
  autosync = useCloudAutosync({
    projectId: project.value.id,
    doc: designHandle.doc,
    project,
  })
  draftSyncStop = watchEffect(() => {
    draftSyncStatus.value = autosync?.syncStatus.value ?? 'idle'
  })
})

// --- Persist editor-state changes back to its reactive store ---
watch(
  [viewMode, splitRatio, cameraState, selectedModules, zoomPercent, assemblyOpenDoorsDrawers, assemblySpaceModulesView, moduleVolumeHelpersVisible, renderMode, publicStyle, cutlistSelectedDrawingKey],
  () => {
    if (!editorStateHandle) return
    const s = editorStateHandle.state
    s.viewMode = viewMode.value
    s.splitRatio = splitRatio.value
    s.projectDesignerSplitRatio = 0.58
    s.projectDesignerZoomPercent = zoomPercent.value
    s.selectedModuleIds = selectedModules.value.map(module => module.id)
    s.camera = cameraState.value
    s.assemblyOpenDoorsDrawers = assemblyOpenDoorsDrawers.value
    s.assemblySpaceModulesView = assemblySpaceModulesView.value
    s.moduleVolumeHelpersVisible = moduleVolumeHelpersVisible.value
    s.renderMode = renderMode.value
    s.publicStyle = normalizePublicStyle(publicStyle.value)
    s.cutlistSelectedDrawingKey = cutlistSelectedDrawingKey.value
  },
  { deep: true },
)

watch(viewMode, (mode) => {
  if (mode === 'style' && !styleTabFlag.value) {
    viewMode.value = 'assembly'
    return
  }
  if (mode !== 'cutlist') cutlistSelectedDrawingKey.value = null
  if (mode !== 'assembly') inputsCollapsed.value = false
})

let cloudStyleSyncTimer: ReturnType<typeof setTimeout> | undefined

function queueCloudStyleSync() {
  if (!project.value || !isCloudAuthed.value) return
  if (cloudStyleSyncTimer) clearTimeout(cloudStyleSyncTimer)
  cloudStyleSyncTimer = setTimeout(async () => {
    if (!project.value || !isCloudAuthed.value) return
    try {
      const style = normalizePublicStyle(publicStyle.value)
      cloudRecord.value = cloudRecord.value?.id
        ? await updateCloudProjectStyle(cloudRecord.value.id, style)
        : await ensureCloudProject(project.value, style)
    }
    catch {
      // Best-effort cloud style sync; local editor-state persistence still owns the draft.
    }
  }, 700)
}

watch(
  publicStyle,
  () => {
    if (!loading.value) queueCloudStyleSync()
  },
  { deep: true },
)

// --- Keyboard shortcuts ---
function isFormField(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function onKeydown(e: KeyboardEvent) {
  // Tab — toggle inputs collapsed in assembly mode (only when not in form field).
  if (
    e.code === 'Tab'
    && !e.repeat
    && viewMode.value === 'assembly'
    && project.value
    && !loading.value
    && !renameOpen.value
    && !isFormField(e.target)
  ) {
    e.preventDefault()
    inputsCollapsed.value = !inputsCollapsed.value
    return
  }
  if (!(e.metaKey || e.ctrlKey)) return
  if (e.altKey) return
  if (isFormField(e.target)) return
  const key = e.key.toLowerCase()
  const code = e.code
  const isZ = key === 'z' || (key !== 'y' && code === 'KeyZ')
  const isY = key === 'y' || (key !== 'z' && code === 'KeyY')
  if (isZ && !e.shiftKey) {
    e.preventDefault()
    undoFn.value()
  }
  else if (isY || (isZ && e.shiftKey)) {
    e.preventDefault()
    redoFn.value()
  }
}

onBeforeUnmount(() => {
  if (import.meta.client) window.removeEventListener('keydown', onKeydown)
  mobileViewportQuery?.removeEventListener('change', updateMobileViewport)
  mobileViewportQuery = null
  if (cloudStyleSyncTimer) clearTimeout(cloudStyleSyncTimer)
  disposeProjectHandles()
})

// --- Camera change → editor state ---
function onCameraChange(state: CameraState | null) {
  cameraState.value = normalizeCameraState(state)
}

// --- Cloud actions ---
const showVerifyOverlay = computed(() => !!project.value && userNeedsEmailVerification.value)

function onPublished(rec: CloudProjectRecord) {
  cloudRecordMutatedAt.value = Date.now()
  cloudRecord.value = rec
}
function onUnpublished() {
  cloudRecordMutatedAt.value = Date.now()
  if (cloudRecord.value) cloudRecord.value = { ...cloudRecord.value, visibility: 'private' }
}
function retryDraftSync() {
  autosync?.retrySync()
}

function onCanvasRenderModeUpdate(value: 'rendered' | 'render-debug' | 'technical' | undefined) {
  if (!value) return
  if (viewMode.value === 'style') {
    publicStyle.value = normalizePublicStyle({
      ...publicStyle.value,
      renderStyle: value === 'technical' ? 'technical' : 'rendered',
    })
    return
  }
  renderMode.value = value
}

const renameOpen = ref(false)
const renameValue = ref('')
const deleteOpen = ref(false)
const deleteError = ref('')
const demoToggleError = ref('')

function openRename() {
  if (!project.value) return
  renameValue.value = project.value.name
  renameOpen.value = true
}

async function confirmRename() {
  if (!project.value) return
  const updated = await renameLocalProject(project.value.id, renameValue.value)
  if (updated) {
    project.value = updated
    if (isCloudAuthed.value) {
      try {
        cloudRecord.value = await ensureCloudProject(updated, publicStyle.value)
      }
      catch { /* cloud rename is best-effort */ }
    }
  }
  renameOpen.value = false
}

async function duplicateProject() {
  if (!project.value) return
  const duplicate = await duplicateLocalProject(project.value.id)
  if (duplicate) await navigateTo(`/project/${duplicate.id}`)
}

function safeFileName(): string {
  return (project.value?.name.trim() || 'project').replace(/[<>:"/\\|?*]/g, '-')
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.click()
  URL.revokeObjectURL(url)
}

async function exportProject() {
  if (!project.value || !docRef.value || !import.meta.client) return
  const blob = exportDoc(docRef.value as Parameters<typeof exportDoc>[0])
  downloadBlob(blob, `${safeFileName()}.morti`)
}

async function exportModel(format: 'glb' | 'gltf') {
  if (!project.value || !docRef.value || !import.meta.client || exportingModel.value) return
  const root = projectCanvasRef.value?.getExportRoot?.()
  if (!root) return
  exportingModel.value = true
  try {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
    const exporter = new GLTFExporter()
    const result = await new Promise<ArrayBuffer | object>((resolve, reject) => {
      exporter.parse(
        root as Parameters<InstanceType<typeof GLTFExporter>['parse']>[0],
        (out) => resolve(out as ArrayBuffer | object),
        (err) => reject(err),
        { binary: format === 'glb' },
      )
    })
    const blob = format === 'glb'
      ? new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' })
      : new Blob([JSON.stringify(result)], { type: 'model/gltf+json' })
    downloadBlob(blob, `${safeFileName()}.${format}`)
  }
  finally {
    exportingModel.value = false
  }
}

const deleteDialogMessage = computed<string>(() => {
  const base = `“${project.value?.name ?? 'this project'}” will be removed from this device. This cannot be undone.`
  return deleteError.value ? `${base}\n\n${deleteError.value}` : base
})

function openDelete() {
  deleteError.value = ''
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!project.value) return
  const projectId = project.value.id
  deleteError.value = ''
  if (isCloudAuthed.value) {
    try {
      await softDeleteCloudProjectForClientId(projectId)
    }
    catch (err: unknown) {
      deleteError.value = (err as { message?: string } | null)?.message ?? 'Could not remove the cloud copy. Try again or check your connection.'
      return
    }
  }
  await deleteLocalProject(projectId)
  deleteOpen.value = false
  await navigateTo('/')
}

async function toggleDemo() {
  if (!project.value || !isAdmin.value) return
  demoToggleError.value = ''
  try {
    const rec = cloudRecord.value?.id
      ? cloudRecord.value
      : await ensureCloudProject(project.value, publicStyle.value)
    cloudRecordMutatedAt.value = Date.now()
    cloudRecord.value = await updateCloudProjectDemoFlag(rec.id, !isDemo.value)
  }
  catch (err: unknown) {
    demoToggleError.value = (err as { message?: string } | null)?.message ?? 'Could not update demo status. Check your admin permissions.'
  }
}

function onSplitRatioUpdate(value: number) {
  if (viewMode.value === 'cutlist') return
  if (isMobileViewport.value) mobileSplitRatio.value = value
  else splitRatio.value = value
}

function confirmCutlistWipAlert() {
  cutlistWipConfirmed.value = true
  if (import.meta.client) localStorage.setItem(CUTLIST_WIP_STORAGE_KEY, 'true')
}

function showCutlistWipAlert() {
  cutlistWipConfirmed.value = false
  if (import.meta.client) localStorage.setItem(CUTLIST_WIP_STORAGE_KEY, 'false')
}

const projectMenuItems = computed(() => [
  { label: 'Change name', icon: 'i-lucide-text-cursor-input', onSelect: openRename },
  {
    label: 'Export',
    icon: 'i-lucide-download',
    disabled: !docRef.value,
    children: [
      {
        label: 'Project (.morti)',
        icon: 'i-lucide-file-archive',
        onSelect: () => { void exportProject() },
      },
      {
        label: '3D model (.glb)',
        icon: 'i-lucide-box',
        disabled: exportingModel.value,
        onSelect: () => { void exportModel('glb') },
      },
      {
        label: '3D model (.gltf)',
        icon: 'i-lucide-file-code-2',
        disabled: exportingModel.value,
        onSelect: () => { void exportModel('gltf') },
      },
    ],
  },
  { label: 'Duplicate', icon: 'i-lucide-copy-plus', disabled: !docRef.value, onSelect: () => { void duplicateProject() } },
  ...(isAdmin.value
    ? [
        { type: 'separator' as const },
        {
          label: isDemo.value ? 'Remove from demos' : 'Set as demo',
          icon: isDemo.value ? 'i-lucide-circle-minus' : 'i-lucide-sparkles',
          onSelect: () => { void toggleDemo() },
        },
      ]
    : []),
  { type: 'separator' as const },
  { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: openDelete },
])

const topChromeMaxWidth = computed(() => {
  if (sidebarView.value || collapseEditorInputs.value) {
    return 'min(40rem, calc(100vw - 24px))'
  }
  return `min(40rem, calc((1 - ${activeSplitRatio.value}) * 100vw - 24px))`
})
const mobileActionTop = computed(() => isMobileViewport.value ? '7rem' : '4rem')
const canvasChromeTeleportSelector = computed(() =>
  isMobileViewport.value
    ? '#morti-project-canvas-chrome-host-mobile'
    : '#morti-project-canvas-chrome-host',
)
</script>

<template>
  <div class="project-page relative h-[100dvh] min-h-0 w-full">
      <div
        v-if="project && viewMode === 'cutlist' && !cutlistWipConfirmed"
        class="fixed inset-0 z-[9999] flex h-[100dvh] w-screen cursor-pointer items-center justify-center overflow-hidden px-6 py-6 sm:px-8 sm:py-8"
        role="button"
        tabindex="0"
        aria-label="Dismiss cutlist work-in-progress warning"
        @click="confirmCutlistWipAlert"
        @keydown.enter.prevent="confirmCutlistWipAlert"
        @keydown.space.prevent="confirmCutlistWipAlert"
      >
        <img
          src="/alert.svg"
          alt=""
          class="pointer-events-none h-full min-h-0 w-auto max-w-none select-none object-contain drop-shadow-2xl"
          draggable="false"
        >
        <p class="pointer-events-none absolute left-1/2 top-[calc(50%+((100dvh-4rem)*0.13))] w-[calc((100dvh-3rem)*0.6)] -translate-x-1/2 -translate-y-1/2 text-balance text-center font-black leading-tight text-black [font-size:calc((100dvh-4rem)*0.021)]">
          This part of the app is still a work in progress and has not been tested in real-world builds. Cutlists, measurements, and operations may (and will) contain errors. You are responsible for verifying everything before manufacturing or assembly. Use at your own risk. If you end up building something, I’d love to see it (dms open on x)
        </p>
      </div>
      <button
        v-else-if="project && viewMode === 'cutlist'"
        type="button"
        class="fixed bottom-3 left-3 z-50 size-14 transition-transform hover:scale-105 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:bottom-4 sm:left-4 sm:size-16"
        aria-label="Show cutlist work-in-progress warning"
        @click="showCutlistWipAlert"
      >
        <img
          src="/alert-sm.svg"
          alt=""
          class="size-full select-none"
          draggable="false"
        >
      </button>

      <EditorSplit
        :split-ratio="activeSplitRatio"
        :divider-locked="viewMode === 'cutlist'"
        :collapse-inputs="collapseEditorInputs"
        :hide-divider="sidebarView"
        :inputs-basis="sidebarView && !isMobileViewport ? '20rem' : ''"
        :reverse-on-mobile-stack="true"
        :reverse-on-desktop="sidebarView"
        @update:split-ratio="onSplitRatioUpdate"
      >
        <!-- Inputs (left) pane -->
        <div
          v-if="project"
          class="project-input-pane relative flex h-full min-h-0 flex-col overflow-hidden"
        >
          <LazyProjectDesigner
            v-if="!userNeedsEmailVerification && viewMode === 'assembly' && docRef"
            :ydoc="(docRef as any)"
            :selected-modules="selectedModules"
            :zoom-percent="zoomPercent"
            class="min-h-0 flex-1"
            @update:selected-modules="(v) => (selectedModules = v)"
            @update:zoom-percent="(v) => (zoomPercent = v)"
          />
          <LazyProjectCutlist
            v-else-if="!userNeedsEmailVerification && viewMode === 'cutlist' && docRef"
            v-model:selected-drawing-key="cutlistSelectedDrawingKey"
            :ydoc="(docRef as any)"
            class="min-h-0 flex-1 px-3 pb-3 sm:px-5 sm:pb-5"
          />
          <LazyProjectConstructionEditor
            v-else-if="!userNeedsEmailVerification && viewMode === 'construction' && docRef"
            :ydoc="(docRef as any)"
            class="min-h-0 flex-1"
          />
          <div
            v-else-if="!userNeedsEmailVerification && styleTabFlag && viewMode === 'style'"
            class="min-h-0 flex-1 overflow-hidden"
          >
            <ProjectStylePanel
              v-model="publicStyle"
              :surface="isMobileViewport ? 'pane' : 'sidebar'"
            />
          </div>
          <div
            v-else
            class="min-h-0 flex-1 bg-muted/10"
            aria-hidden="true"
          />
        </div>

        <!-- Preview (right) pane -->
        <template #preview>
          <div
            v-if="loading"
            class="flex h-full items-center justify-center"
          >
            <UIcon
              name="i-lucide-loader-circle"
              class="size-8 animate-spin text-muted"
            />
          </div>

          <template v-else-if="project">
            <div
              v-if="userNeedsEmailVerification"
              class="h-full min-h-0 bg-muted/20"
              aria-hidden="true"
            />
            <Suspense v-else>
              <template #fallback>
                <div class="flex h-full items-center justify-center rounded-lg bg-default shadow-sm">
                  <UIcon
                    name="i-lucide-loader-circle"
                    class="size-6 animate-spin text-muted"
                  />
                </div>
              </template>

              <div class="relative h-full min-h-0 w-full">
                <LazyProjectCanvas
                  v-if="docRef && (viewMode === 'assembly' || sidebarView)"
                  ref="projectCanvasRef"
                  :ydoc="(docRef as any)"
                  :public-style="publicStyle"
                  :render-mode="canvasRenderMode"
                  :selected-module-ids="selectedModuleIds"
                  :initial-camera-state="cameraState"
                  :assembly-open-doors-drawers="assemblyOpenDoorsDrawers"
                  :assembly-space-modules-view="assemblySpaceModulesView"
                  :module-volume-helpers-visible="moduleVolumeHelpersVisible"
                  :headless-capture="false"
                  :capture-yaw-radians="0"
                  :canvas-chrome-teleport-selector="canvasChromeTeleportSelector"
                  class="h-full w-full"
                  @camera-change="onCameraChange"
                  @update:assembly-open-doors-drawers="(v: boolean) => (assemblyOpenDoorsDrawers = v)"
                  @update:assembly-space-modules-view="(v: boolean) => (assemblySpaceModulesView = v)"
                  @update:module-volume-helpers-visible="(v: boolean) => (moduleVolumeHelpersVisible = v)"
                  @update:render-mode="onCanvasRenderModeUpdate"
                />
                <LazyProjectCutlistPanelGrid
                  v-else-if="docRef && viewMode === 'cutlist'"
                  v-model:selected-drawing-key="cutlistSelectedDrawingKey"
                  :ydoc="(docRef as any)"
                  class="h-full min-h-0 w-full"
                />
              </div>
            </Suspense>
          </template>

          <div
            v-else
            class="flex h-full flex-col items-center justify-center gap-4 px-4"
          >
            <p class="text-pretty text-center text-muted">
              Project not found.
            </p>
            <UButton
              to="/"
              label="Back to projects"
              class="transition-transform active:scale-[0.97]"
            />
            </div>
        </template>
      </EditorSplit>

      <!-- Top-left chrome: project menu + name + view-mode pill -->
      <div
        v-if="project"
        class="project-top-chrome pointer-events-none fixed inset-x-3 top-3 z-30 flex flex-wrap items-start gap-2 md:inset-x-auto md:left-4 md:top-4 md:flex-nowrap md:gap-2.5"
        :style="{ '--project-top-chrome-max-width': topChromeMaxWidth }"
      >
        <div class="pointer-events-auto flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-2 shadow-sm sm:gap-2.5 sm:px-3 md:max-w-[min(20rem,calc(100vw-6rem))]">
          <UButton
            to="/"
            variant="ghost"
            color="neutral"
            icon="i-lucide-arrow-left"
            size="sm"
            class="shrink-0 text-muted opacity-55 transition-[opacity,color,transform] hover:bg-transparent hover:text-highlighted hover:opacity-100 active:scale-[0.97]"
            aria-label="Home"
          />
          <div class="project-title-row flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <h1 class="project-title block min-w-0 truncate whitespace-nowrap text-sm font-semibold text-highlighted sm:text-base">
              {{ project.name }}
            </h1>
            <UPopover
              v-if="isEditingPublishedCopy"
              :content="{ side: 'bottom', align: 'start', sideOffset: 8 }"
            >
              <button
                type="button"
                class="public-badge group inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-elevated px-2 text-[11px] font-medium leading-none text-toned ring-1 ring-default/40 transition-[color,background-color,transform] hover:bg-accented hover:text-highlighted active:scale-[0.97]"
                aria-label="This project is the public copy. Click for options."
              >
                <span
                  class="size-1.5 rounded-full bg-warning transition-transform group-hover:scale-110"
                  aria-hidden="true"
                />
                <span class="public-badge-label">Public</span>
              </button>
              <template #content>
                <div class="flex max-w-xs flex-col gap-3 p-3">
                  <p class="text-pretty text-sm text-default">
                    You're editing the <span class="font-medium text-highlighted">public copy</span>. Changes here are visible to everyone.
                  </p>
                  <UButton
                    size="sm"
                    color="primary"
                    variant="soft"
                    label="Make a local copy"
                    icon="i-lucide-copy-plus"
                    block
                    class="transition-transform active:scale-[0.97]"
                    @click="duplicateProject"
                  />
                </div>
              </template>
            </UPopover>
            <UDropdownMenu
              :items="projectMenuItems"
              :content="{ align: 'end' }"
              :modal="false"
            >
              <UButton
                icon="i-lucide-ellipsis-vertical"
                variant="ghost"
                color="neutral"
                size="sm"
                class="shrink-0 text-muted opacity-55 transition-[opacity,color,transform] hover:bg-transparent hover:text-highlighted hover:opacity-100 active:scale-[0.97]"
                aria-label="Project menu"
              />
            </UDropdownMenu>
          </div>
        </div>

        <div class="project-mobile-cloud-actions pointer-events-auto flex shrink-0 md:hidden">
          <ProjectCloudActions
            :project="project"
            :cloud-record="cloudRecord"
            :public-style="publicStyle"
            :draft-sync-status="draftSyncStatus"
            @retry-draft-sync="retryDraftSync"
            @published="onPublished"
            @unpublished="onUnpublished"
          />
        </div>

        <div
          class="project-mobile-line-break"
          aria-hidden="true"
        />

        <div class="project-view-tabs pointer-events-auto flex h-10 shrink-0 items-center gap-1 rounded-full bg-muted px-1 shadow-sm">
          <UButton
            size="xs"
            :variant="viewMode === 'assembly' ? 'solid' : 'ghost'"
            color="neutral"
            label="Diseño"
            class="h-8 rounded-full transition-transform active:scale-[0.97]"
            @click="viewMode = 'assembly'"
          />
          <UButton
            size="xs"
            :variant="viewMode === 'cutlist' ? 'solid' : 'ghost'"
            color="neutral"
            label="Despiece"
            class="h-8 rounded-full transition-transform active:scale-[0.97]"
            @click="viewMode = 'cutlist'"
          />
          <UButton
            size="xs"
            :variant="viewMode === 'construction' ? 'solid' : 'ghost'"
            color="neutral"
            label="Estructura"
            class="h-8 rounded-full transition-transform active:scale-[0.97]"
            @click="viewMode = 'construction'"
          />
          <UButton
            v-if="styleTabFlag"
            size="xs"
            :variant="viewMode === 'style' ? 'solid' : 'ghost'"
            color="neutral"
            label="Estilo"
            class="h-8 rounded-full transition-transform active:scale-[0.97]"
            @click="viewMode = 'style'"
          />
        </div>

        <div
          v-if="isMobileViewport"
          id="morti-project-canvas-chrome-host-mobile"
          class="project-mobile-canvas-chrome pointer-events-auto min-h-0 shrink-0"
        />
      </div>

      <!-- Top-right chrome: cloud actions -->
      <div
        v-if="project && !userNeedsEmailVerification"
        class="project-top-actions fixed inset-x-3 top-[var(--project-mobile-action-top)] z-30 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-1 md:inset-x-auto md:right-4 md:top-4 md:max-w-[min(calc(100vw-1.5rem),56rem)]"
        :style="{ '--project-mobile-action-top': mobileActionTop }"
      >
        <div class="pointer-events-auto flex max-w-full flex-row flex-wrap items-center justify-end gap-2">
          <div
            v-if="!isMobileViewport"
            id="morti-project-canvas-chrome-host"
            class="min-h-0 shrink-0"
          />
          <div class="hidden md:block">
            <ProjectCloudActions
              :project="project"
              :cloud-record="cloudRecord"
              :public-style="publicStyle"
              :draft-sync-status="draftSyncStatus"
              @retry-draft-sync="retryDraftSync"
              @published="onPublished"
              @unpublished="onUnpublished"
            />
          </div>
        </div>
        <UAlert
          v-if="demoToggleError"
          color="error"
          variant="soft"
          :title="demoToggleError"
          class="pointer-events-auto max-w-md"
        />
      </div>

      <!-- Verify-email overlay -->
      <div
        v-if="showVerifyOverlay"
        class="pointer-events-auto absolute inset-0 z-40 flex flex-col bg-default/95 backdrop-blur-md"
      >
        <div class="pointer-events-auto flex shrink-0 items-center gap-2 px-4 py-3 shadow-sm">
          <UButton
            to="/"
            variant="ghost"
            color="neutral"
            icon="i-lucide-arrow-left"
            size="sm"
            label="Back to projects"
            class="transition-transform active:scale-[0.97]"
          />
        </div>
        <VerifyEmailGate class="min-h-0 flex-1 overflow-auto" />
      </div>

      <LazyAppFormDialog
        v-if="project && renameOpen"
        v-model:open="renameOpen"
        title="Change name"
        primary-label="Save"
        @primary="confirmRename"
      >
        <UFormField
          label="Name"
          class="w-full"
        >
          <UInput
            v-model="renameValue"
            class="w-full"
            placeholder="Project name"
            autofocus
            @keydown.enter.prevent="confirmRename"
          />
        </UFormField>
      </LazyAppFormDialog>

      <LazyAppConfirmDialog
        v-if="project && deleteOpen"
        v-model:open="deleteOpen"
        title="Delete project?"
        :message="deleteDialogMessage"
        cancel-label="Cancel"
        confirm-label="Delete"
        @confirm="confirmDelete"
      />
  </div>
</template>

<style scoped>
.project-top-chrome {
  max-width: calc(100vw - 1.5rem);
}

.project-title {
  text-wrap: nowrap;
}

.project-title-row {
  container-type: inline-size;
}

.public-badge-label {
  display: none;
}

.project-mobile-line-break {
  display: none;
}

@container (min-width: 10.5rem) {
  .public-badge-label {
    display: inline;
  }
}

@media (max-width: 767.98px) {
  .project-top-chrome {
    row-gap: 0.5rem;
  }

  .project-mobile-line-break {
    display: block;
    order: 2;
    flex-basis: 100%;
    width: 0;
    height: 0;
  }

  .project-view-tabs {
    order: 3;
  }

  .project-mobile-canvas-chrome {
    order: 4;
    margin-left: auto;
  }
}

@media (max-width: 399.98px) {
  .project-mobile-cloud-actions :deep(button) {
    padding-inline: 0.75rem;
  }
}

@media (min-width: 768px) {
  .project-top-chrome {
    width: var(--project-top-chrome-max-width);
    max-width: var(--project-top-chrome-max-width);
  }

  .project-top-chrome > :first-child {
    flex: 1 1 auto;
    max-width: none;
  }

  .public-badge-label {
    display: inline;
  }
}

@media (max-width: 767.98px) {
  .project-top-actions :deep(#morti-project-canvas-chrome-host > *) {
    justify-content: flex-end;
    max-width: 100%;
  }
}
</style>
