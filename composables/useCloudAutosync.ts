import * as Y from 'yjs'
import type { Ref } from 'vue'
import type { LocalProjectRow } from '~~/shared/domain/types'
import { getProjectFingerprint } from '~~/shared/domain/fingerprint'
import { readFurnitureDoc } from '~~/shared/yjs/doc'

const AUTOSYNC_DEBOUNCE_MS = 1500

// Module-scoped per-projectId last-uploaded fingerprint cache.
const lastUploadedByProject: Map<string, string> = new Map()
type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error'

interface UseCloudAutosyncArgs {
  projectId: string
  doc: Y.Doc
  project: Ref<LocalProjectRow | null>
}

export function useCloudAutosync({ projectId, doc, project }: UseCloudAutosyncArgs) {
  const { isCloudAuthed } = useAuth()
  const { ensureCloudProject, fetchSnapshotBytes, uploadSnapshotBytes } = useCloudProjects()
  const { putDesignSnapshot, setLocalProjectCloudId } = useLocalProjects()
  const syncStatus = ref<SyncStatus>('idle')
  const lastSyncError = ref<string | null>(null)

  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let syncChain = Promise.resolve()
  let remoteMerged = false

  async function runSync(): Promise<void> {
    if (disposed) return
    if (!isCloudAuthed.value) {
      syncStatus.value = 'idle'
      lastSyncError.value = null
      return
    }
    if (import.meta.client && !navigator.onLine) {
      syncStatus.value = 'offline'
      lastSyncError.value = null
      return
    }
    const currentProject = project.value
    if (!currentProject || currentProject.id !== projectId) {
      syncStatus.value = 'idle'
      lastSyncError.value = null
      return
    }

    syncStatus.value = 'syncing'
    lastSyncError.value = null
    try {
      const record = await ensureCloudProject(currentProject)
      await setLocalProjectCloudId(projectId, record.id)
      if (!remoteMerged) {
        const remote = await fetchSnapshotBytes(record)
        if (remote && remote.byteLength > 0) {
          Y.applyUpdate(doc, remote)
          const merged = Y.encodeStateAsUpdate(doc)
          await putDesignSnapshot(projectId, merged)
        }
        remoteMerged = true
      }
      const snapshot = readFurnitureDoc(doc)
      const fp = getProjectFingerprint(snapshot)
      if (lastUploadedByProject.get(projectId) === fp) {
        syncStatus.value = 'synced'
        return
      }
      const update = Y.encodeStateAsUpdate(doc)
      await uploadSnapshotBytes(record.id, projectId, update)
      lastUploadedByProject.set(projectId, fp)
      syncStatus.value = 'synced'
    }
    catch (err: unknown) {
      syncStatus.value = 'error'
      lastSyncError.value = (err as { message?: string } | null)?.message ?? 'Sync failed'
    }
  }

  async function syncNow(): Promise<void> {
    if (disposed) return
    syncChain = syncChain.then(runSync, runSync)
    return syncChain
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void syncNow()
    }, AUTOSYNC_DEBOUNCE_MS)
  }

  function onUpdate() {
    schedule()
  }

  doc.on('update', onUpdate)

  function dispose() {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    doc.off('update', onUpdate)
    if (import.meta.client) {
      window.removeEventListener('online', retrySync)
      window.removeEventListener('focus', retrySync)
    }
  }

  function retrySync() {
    if (!disposed) void syncNow()
  }

  if (import.meta.client) {
    window.addEventListener('online', retrySync)
    window.addEventListener('focus', retrySync)
  }
  void syncNow()

  if (getCurrentScope()) onScopeDispose(dispose)

  return {
    syncStatus,
    lastSyncError,
    retrySync,
    syncNow,
    dispose,
  }
}
