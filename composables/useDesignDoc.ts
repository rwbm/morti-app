import * as Y from 'yjs'
import type { FurnitureDoc } from '~~/shared/domain/types'
import { ensureInitialized, getFurnitureMap, readFurnitureDoc } from '~~/shared/yjs/doc'
import { STORES, idbBoundedRange, idbGet, idbPut } from '~~/shared/idb/morti-db'

interface DesignStateRow {
  projectId: string
  update?: Uint8Array
  snapshot?: ArrayBuffer | Uint8Array
  updatedAt?: string
}

interface UndoCheckpointRow {
  projectId: string
  seq: number
  createdAt: number
  snapshot: Uint8Array
}

const SNAPSHOT_DEBOUNCE_MS = 400
const CHECKPOINT_DEBOUNCE_MS = 220
const CHECKPOINT_CAP = 100

function debounce(fn: () => void, ms: number): { call: () => void, flush: () => void, cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null
  return {
    call() {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        t = null
        fn()
      }, ms)
    },
    flush() {
      if (t) {
        clearTimeout(t)
        t = null
        fn()
      }
    },
    cancel() {
      if (t) {
        clearTimeout(t)
        t = null
      }
    },
  }
}

export async function useDesignDoc(projectId: string) {
  const doc = new Y.Doc()
  const existing = await idbGet<DesignStateRow>(STORES.designState, projectId)
  const existingBytes = existing?.update ?? existing?.snapshot
  if (existingBytes) {
    try {
      Y.applyUpdate(doc, existingBytes instanceof Uint8Array ? existingBytes : new Uint8Array(existingBytes))
    }
    catch {
      // ignore — start fresh
    }
  }
  ensureInitialized(doc)

  const furnitureMap = getFurnitureMap(doc)
  const undoManager = new Y.UndoManager(furnitureMap, {
    captureTimeout: 250,
    trackedOrigins: new Set<unknown>([null, undefined, 'setInteriorShelfCount', 'updateConstruction', 'setConfigValue', 'setExteriorDimensions', 'insertColumn', 'removeColumn', 'setColumnWidth', 'insertModule', 'removeModule', 'setModuleType', 'setModuleHeight', 'setDrawerCount']),
  })

  const state = ref<FurnitureDoc>(readFurnitureDoc(doc))
  const canUndo = ref<boolean>(undoManager.undoStack.length > 0)
  const canRedo = ref<boolean>(undoManager.redoStack.length > 0)

  function refreshState() {
    state.value = readFurnitureDoc(doc)
  }

  function refreshUndoFlags() {
    canUndo.value = undoManager.undoStack.length > 0
    canRedo.value = undoManager.redoStack.length > 0
  }

  // ---------- Persistence ----------
  async function persistSnapshot() {
    const update = Y.encodeStateAsUpdate(doc)
    await idbPut<DesignStateRow>(STORES.designState, {
      projectId,
      update,
      snapshot: update,
      updatedAt: new Date().toISOString(),
    })
  }

  async function pushCheckpoint() {
    const update = Y.encodeStateAsUpdate(doc)
    const range = IDBKeyRange.bound([projectId, -Infinity], [projectId, Infinity])
    const existingRows = await idbBoundedRange<UndoCheckpointRow>(STORES.designUndoCheckpoints, range)
    const nextIndex = existingRows.length === 0
      ? 0
      : Math.max(...existingRows.map(r => r.seq)) + 1
    await idbPut<UndoCheckpointRow>(STORES.designUndoCheckpoints, {
      projectId,
      seq: nextIndex,
      createdAt: Date.now(),
      snapshot: update,
    })
    if (existingRows.length + 1 > CHECKPOINT_CAP) {
      const sorted = [...existingRows, { projectId, seq: nextIndex, createdAt: Date.now(), snapshot: update }]
        .sort((a, b) => a.seq - b.seq)
      const toDrop = sorted.length - CHECKPOINT_CAP
      const { idbDelete } = await import('~~/shared/idb/morti-db')
      for (let i = 0; i < toDrop; i++) {
        const row = sorted[i]
        await idbDelete(STORES.designUndoCheckpoints, [row.projectId, row.seq])
      }
    }
  }

  const snapshotDebounced = debounce(() => {
    void persistSnapshot()
  }, SNAPSHOT_DEBOUNCE_MS)

  const checkpointDebounced = debounce(() => {
    void pushCheckpoint()
  }, CHECKPOINT_DEBOUNCE_MS)

  function onUpdate() {
    refreshState()
    refreshUndoFlags()
    snapshotDebounced.call()
    checkpointDebounced.call()
  }

  function onStackChange() {
    refreshUndoFlags()
  }

  doc.on('update', onUpdate)
  undoManager.on('stack-item-added', onStackChange)
  undoManager.on('stack-item-popped', onStackChange)

  function undo() {
    if (undoManager.undoStack.length > 0) {
      undoManager.undo()
      refreshState()
      refreshUndoFlags()
    }
  }

  function redo() {
    if (undoManager.redoStack.length > 0) {
      undoManager.redo()
      refreshState()
      refreshUndoFlags()
    }
  }

  function dispose() {
    snapshotDebounced.flush()
    checkpointDebounced.cancel()
    doc.off('update', onUpdate)
    undoManager.off('stack-item-added', onStackChange)
    undoManager.off('stack-item-popped', onStackChange)
    undoManager.destroy()
    doc.destroy()
  }

  return {
    doc,
    state: computed<FurnitureDoc>(() => state.value),
    undo,
    redo,
    canUndo: computed<boolean>(() => canUndo.value),
    canRedo: computed<boolean>(() => canRedo.value),
    dispose,
  }
}
