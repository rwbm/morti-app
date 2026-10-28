import type { CameraState, ProjectEditorStateRow } from '~~/shared/domain/types'
import { DEFAULT_CAMERA_STATE, normalizePublicStyle } from '~~/shared/domain/defaults'
import { STORES, idbGet, idbPut } from '~~/shared/idb/morti-db'

const PERSIST_DEBOUNCE_MS = 450

function defaultCameraState(): CameraState {
  return {
    position: [...DEFAULT_CAMERA_STATE.position] as [number, number, number],
    quaternion: [...DEFAULT_CAMERA_STATE.quaternion] as [number, number, number, number],
    target: [...DEFAULT_CAMERA_STATE.target] as [number, number, number],
  }
}

function defaultEditorState(projectId: string): ProjectEditorStateRow {
  return {
    id: projectId,
    projectId,
    viewMode: 'assembly',
    splitRatio: 0.55,
    projectDesignerSplitRatio: 0.58,
    projectDesignerZoomPercent: 100,
    selectedModuleIds: [],
    camera: defaultCameraState(),
    assemblyOpenDoorsDrawers: false,
    assemblySpaceModulesView: false,
    moduleVolumeHelpersVisible: false,
    renderMode: 'render-debug',
    publicStyle: normalizePublicStyle(),
    cutlistSelectedDrawingKey: null,
  }
}

export async function useEditorState(projectId: string) {
  const loaded = await idbGet<ProjectEditorStateRow>(STORES.projectEditorState, projectId)
  const initial: ProjectEditorStateRow = loaded
    ? { ...defaultEditorState(projectId), ...loaded, id: projectId, projectId }
    : defaultEditorState(projectId)
  initial.publicStyle = normalizePublicStyle(initial.publicStyle)

  const state = reactive<ProjectEditorStateRow>(initial)

  let timer: ReturnType<typeof setTimeout> | null = null

  async function persistNow(): Promise<void> {
    const snapshot: ProjectEditorStateRow = structuredClone(toRaw(state)) as ProjectEditorStateRow
    snapshot.id = projectId
    snapshot.projectId = projectId
    ;(snapshot as ProjectEditorStateRow & { updatedAt: string }).updatedAt = new Date().toISOString()
    if (snapshot.viewMode !== 'assembly' && snapshot.viewMode !== 'cutlist' && snapshot.viewMode !== 'style' && snapshot.viewMode !== 'construction') snapshot.viewMode = 'assembly'
    snapshot.camera = snapshot.camera ?? defaultCameraState()
    snapshot.renderMode = snapshot.renderMode === 'technical' ? 'technical' : 'render-debug'
    snapshot.publicStyle = normalizePublicStyle(snapshot.publicStyle)
    snapshot.projectDesignerZoomPercent = Number(snapshot.projectDesignerZoomPercent ?? 100)
    snapshot.selectedModuleIds = Array.isArray(snapshot.selectedModuleIds) ? snapshot.selectedModuleIds.map(String) : []
    snapshot.cutlistSelectedDrawingKey = typeof snapshot.cutlistSelectedDrawingKey === 'string' && snapshot.cutlistSelectedDrawingKey.length > 0
      ? snapshot.cutlistSelectedDrawingKey.slice(0, 512)
      : null
    await idbPut<ProjectEditorStateRow>(STORES.projectEditorState, snapshot)
  }

  function schedulePersist() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  watch(
    () => JSON.stringify(state),
    () => schedulePersist(),
  )

  function dispose() {
    if (timer) {
      clearTimeout(timer)
      timer = null
      void persistNow()
    }
  }

  if (getCurrentScope()) onScopeDispose(dispose)

  return {
    state,
    persistNow,
    dispose,
  }
}
