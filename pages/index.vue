<script setup lang="ts">
import type { CloudProjectRecord, FurnitureColumn, FurnitureConfig, FurnitureConstruction, LocalProjectRow } from '~~/shared/domain/types'

interface PreviewData {
  columns: FurnitureColumn[]
  config: FurnitureConfig | null
  construction?: FurnitureConstruction
}

const { user, isAuthed, isCloudAuthed, isLocalBypass, signOut } = useAuth()
const local = useLocalProjects()
const cloud = useCloudProjects()

const AppConfirmDialog = defineAsyncComponent(() => import('~/components/app/AppConfirmDialog.vue'))
const AppFormDialog = defineAsyncComponent(() => import('~/components/app/AppFormDialog.vue'))
const AuthModal = defineAsyncComponent(() => import('~/components/app/AuthModal.vue'))

const authModalOpen = ref(false)
const importInputRef = ref<HTMLInputElement | null>(null)

const hydrated = ref(false)
const loading = ref(true)
const demoLoading = ref(false)
const importError = ref('')
const demoError = ref('')
const demoMode = ref(false)

const localProjects = ref<LocalProjectRow[]>([])
const localPreviewMap = ref<Record<string, PreviewData>>({})
const cloudRecordMap = ref<Record<string, CloudProjectRecord | null>>({})
const demoClientIds = ref<Set<string>>(new Set())
const demos = ref<CloudProjectRecord[]>([])
const demoPreviewMap = ref<Record<string, PreviewData>>({})

const renameOpen = ref(false)
const renameProjectId = ref<string | null>(null)
const renameValue = ref('')
const deleteOpen = ref(false)
const deleteProjectId = ref<string | null>(null)
const deleteError = ref('')
const demoToggleError = ref('')

const isAdmin = computed(() => user.value?.is_admin === true)
const isSignedIn = computed(() => hydrated.value && isAuthed.value)
const showProjects = computed(() => isSignedIn.value)

const cardDemos = computed(() =>
  demos.value.map(rec => ({
    id: rec.id,
    name: rec.name?.trim() || 'Demo project',
    createdAt: rec.created ?? rec.updated ?? new Date(0).toISOString(),
    updatedAt: rec.updated ?? rec.created ?? new Date(0).toISOString(),
    pinned: false,
  })),
)

const renameDialogTitle = 'Rename project'
const deleteDialogMessage = computed(() => {
  const name = deleteProjectId.value
    ? localProjects.value.find(row => row.id === deleteProjectId.value)?.name ?? 'this project'
    : 'this project'
  const base = `"${name}" will be removed from this device. This cannot be undone.`
  return deleteError.value ? `${base}\n\n${deleteError.value}` : base
})

function blankPreview(): PreviewData {
  return { columns: [], config: null }
}

async function decodeSnapshotBytes(bytes: Uint8Array): Promise<PreviewData> {
  const [Y, { ensureInitialized, readFurnitureDoc }] = await Promise.all([
    import('yjs'),
    import('~~/shared/yjs/doc'),
  ])
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, bytes)
    ensureInitialized(doc)
    const data = readFurnitureDoc(doc)
    return { columns: data.columns, config: data.config, construction: data.construction }
  }
  catch {
    return blankPreview()
  }
  finally {
    doc.destroy()
  }
}

async function loadCloudRecordForLocal(row: LocalProjectRow): Promise<CloudProjectRecord | null> {
  try {
    return await cloud.findCloudProjectByClientId(row.id)
  }
  catch {
    return null
  }
}

async function loadDemoPreview(rec: CloudProjectRecord): Promise<PreviewData> {
  if (!rec.snapshot) return blankPreview()
  try {
    const res = await fetch(cloud.getSnapshotURL(rec))
    if (!res.ok) return blankPreview()
    return await decodeSnapshotBytes(new Uint8Array(await res.arrayBuffer()))
  }
  catch {
    return blankPreview()
  }
}

async function loadDemos() {
  demoLoading.value = true
  demoError.value = ''
  try {
    const list = await cloud.listDemos()
    demos.value = list
    const previews = await Promise.all(list.map(async rec => [rec.id, await loadDemoPreview(rec)] as const))
    demoPreviewMap.value = Object.fromEntries(previews)
  }
  catch (err: unknown) {
    demoError.value = (err as { message?: string } | null)?.message ?? 'Could not load demos.'
  }
  finally {
    demoLoading.value = false
  }
}

async function loadProjects() {
  const rows = await local.listLocalProjects()
  localProjects.value = rows

  const [previews, records] = await Promise.all([
    Promise.all(rows.map(async row => [row.id, await decodeSnapshotBytes(await local.getDesignSnapshot(row.id) ?? new Uint8Array())] as const)),
    Promise.all(rows.map(async row => [row.id, await loadCloudRecordForLocal(row)] as const)),
  ])

  localPreviewMap.value = Object.fromEntries(previews)
  cloudRecordMap.value = Object.fromEntries(records)
  demoClientIds.value = new Set(records.map(([, rec]) => rec).filter((rec): rec is CloudProjectRecord => !!rec?.is_demo).map(rec => rec.client_project_id))
}

async function refresh() {
  loading.value = true
  importError.value = ''
  demoToggleError.value = ''
  try {
    if (showProjects.value) await loadProjects()
    else await loadDemos()
  }
  finally {
    loading.value = false
  }
}

onMounted(async () => {
  hydrated.value = true
  await refresh()
})

watch(() => user.value?.id, async () => {
  if (!hydrated.value) return
  demoMode.value = false
  await refresh()
})

async function toggleDemos() {
  demoMode.value = !demoMode.value
  if (demoMode.value) await loadDemos()
}

async function createProject() {
  const row = await local.createLocalProject('untitled')
  await navigateTo(`/project/${row.id}`)
}

function triggerImport() {
  importError.value = ''
  importInputRef.value?.click()
}

async function importProject(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  if (!file) return
  importError.value = ''
  try {
    if (!/\.(morti|madera)$/i.test(file.name)) throw new Error('Choose a .morti file.')
    const row = await local.importMortiFile(file, file.name.replace(/\.(morti|madera)$/i, ''))
    await navigateTo(`/project/${row.id}`)
  }
  catch (err: unknown) {
    importError.value = (err as { message?: string } | null)?.message ?? 'Import failed.'
  }
}

function openRename(project: { id: string, name: string }) {
  renameProjectId.value = project.id
  renameValue.value = project.name
  renameOpen.value = true
}

async function confirmRename() {
  if (!renameProjectId.value) return
  await local.updateLocalProject(renameProjectId.value, { name: renameValue.value })
  renameOpen.value = false
  renameProjectId.value = null
  await loadProjects()
}

function openDelete(projectId: string) {
  deleteError.value = ''
  deleteProjectId.value = projectId
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!deleteProjectId.value) return
  const projectId = deleteProjectId.value
  deleteError.value = ''
  if (isCloudAuthed.value) {
    try {
      await cloud.softDeleteCloudProjectForClientId(projectId)
    }
    catch (err: unknown) {
      deleteError.value = (err as { message?: string } | null)?.message ?? 'Could not remove the cloud copy. Try again or check your connection.'
      return
    }
  }
  await local.deleteLocalProject(projectId)
  deleteOpen.value = false
  deleteProjectId.value = null
  await loadProjects()
}

async function togglePin(projectId: string) {
  const row = localProjects.value.find(project => project.id === projectId)
  if (!row) return
  await local.updateLocalProject(projectId, { pinned: !(row.pinned ?? false) })
  await loadProjects()
}

async function duplicateProject(project: { id: string }) {
  const dup = await local.duplicateLocalProject(project.id)
  if (dup) await navigateTo(`/project/${dup.id}`)
}

async function toggleDemo(projectId: string) {
  if (!isAdmin.value) return
  demoToggleError.value = ''
  const project = localProjects.value.find(row => row.id === projectId)
  if (!project) return
  try {
    const existing = cloudRecordMap.value[projectId]
    const rec = existing?.id ? existing : await cloud.ensureCloudProject({ clientProjectId: project.id, name: project.name })
    const updated = await cloud.setIsDemo(rec.id, !(rec.is_demo ?? false))
    cloudRecordMap.value = { ...cloudRecordMap.value, [projectId]: updated }
    await loadProjects()
  }
  catch (err: unknown) {
    demoToggleError.value = (err as { message?: string } | null)?.message ?? 'Could not update demo status. Check your admin permissions.'
  }
}

function previewForLocal(id: string): PreviewData {
  return localPreviewMap.value[id] ?? blankPreview()
}

function previewForDemo(id: string): PreviewData {
  return demoPreviewMap.value[id] ?? blankPreview()
}

function isPublished(projectId: string): boolean {
  const rec = cloudRecordMap.value[projectId]
  return !!rec?.published_at && rec.published_at.length > 0 && rec.visibility === 'public'
}

function isDemo(projectId: string): boolean {
  return demoClientIds.value.has(projectId) || cloudRecordMap.value[projectId]?.is_demo === true
}
</script>

<template>
  <UContainer class="pb-10 pt-20 sm:pb-14 sm:pt-16">
    <div class="pointer-events-none absolute left-3 top-3 z-30 sm:left-4 sm:top-4">
      <img
        src="/morti_logo.svg"
        alt="Morti"
        width="44"
        height="28"
        decoding="async"
        class="h-7 w-auto select-none"
      >
    </div>

    <div
      v-if="isSignedIn && !isLocalBypass"
      class="absolute right-3 top-3 z-30 sm:right-4 sm:top-4"
    >
      <UButton
        label="Sign out"
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-log-out"
        class="pointer-events-auto shrink-0 text-muted opacity-80 transition-[opacity,transform] hover:opacity-100 active:scale-[0.97]"
        @click="signOut"
      />
    </div>
    <div
      v-else-if="hydrated && !isSignedIn"
      class="absolute right-3 top-3 z-30 sm:right-4 sm:top-4"
    >
      <UButton
        label="Sign in"
        color="neutral"
        icon="i-lucide-log-in"
        class="pointer-events-auto shrink-0 transition-transform active:scale-[0.97]"
        @click="authModalOpen = true"
      />
    </div>

    <div class="w-full max-w-6xl">
      <div class="sticky top-0 z-20 mb-4 -mx-[max(1rem,calc((100vw-100%)/2))] border-b border-default/40 bg-default/95 backdrop-blur shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] supports-[backdrop-filter]:bg-default/80">
        <div class="mx-auto flex w-full max-w-6xl min-w-0 flex-col items-stretch justify-between gap-3 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-6">
          <div class="flex min-w-0 flex-row flex-wrap items-baseline gap-x-4 gap-y-1">
            <template v-if="isSignedIn">
              <button
                type="button"
                :class="[
                  'morti-tab text-balance text-left text-2xl tracking-[-0.015em] transition-[color,transform] duration-200 active:scale-[0.97] sm:text-3xl',
                  !demoMode ? 'morti-tab--active font-semibold text-highlighted' : 'font-medium text-muted hover:text-default',
                ]"
                @click="demoMode = false"
              >
                Projects
              </button>
              <button
                type="button"
                :class="[
                  'morti-tab text-balance text-left text-2xl tracking-[-0.015em] transition-[color,transform] duration-200 active:scale-[0.97] sm:text-3xl',
                  demoMode ? 'morti-tab--active font-semibold text-highlighted' : 'font-medium text-muted hover:text-default',
                ]"
                @click="toggleDemos"
              >
                Demos
              </button>
            </template>
            <template v-else>
              <h1 class="text-balance text-2xl font-semibold text-highlighted sm:text-3xl">
                Morti
              </h1>
              <p class="text-sm text-muted">
                Simple furniture builder
              </p>
            </template>
          </div>

          <div class="flex min-w-0 flex-wrap items-center justify-start gap-2 sm:justify-end">
            <template v-if="isSignedIn">
              <UButton
                icon="i-lucide-folder-input"
                label="Import"
                color="neutral"
                variant="outline"
                class="transition-transform active:scale-[0.97]"
                @click="triggerImport"
              />
              <UButton
                icon="i-lucide-plus"
                label="New project"
                color="primary"
                class="transition-transform active:scale-[0.97]"
                @click="createProject"
              />
            </template>
          </div>
        </div>
      </div>

      <UAlert
        v-if="isSignedIn && importError"
        color="error"
        variant="soft"
        :title="importError"
        class="mb-4"
      />
      <UAlert
        v-if="isSignedIn && demoToggleError"
        color="error"
        variant="soft"
        :title="demoToggleError"
        class="mb-4"
      />

      <div
        v-if="loading"
        class="flex items-center justify-center py-16 animate-pulse"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-8 animate-spin text-muted"
        />
      </div>

      <template v-else-if="showProjects">
        <div
          v-if="!demoMode && localProjects.length === 0"
          class="flex flex-col items-center gap-3 rounded-2xl bg-elevated/40 px-6 py-12 text-center shadow-sm ring-1 ring-default/60"
        >
          <UIcon
            name="i-lucide-package-open"
            class="size-8 text-muted"
          />
          <p class="text-pretty text-sm text-muted">
            No projects yet. Create one to get started.
          </p>
          <UButton
            icon="i-lucide-plus"
            label="New project"
            color="neutral"
            class="transition-transform active:scale-[0.97]"
            @click="createProject"
          />
        </div>

        <template v-else-if="demoMode">
          <div
            v-if="demoLoading"
            class="flex items-center justify-center py-16 animate-pulse"
          >
            <UIcon
              name="i-lucide-loader-circle"
              class="size-8 animate-spin text-muted"
            />
          </div>
          <UAlert
            v-else-if="demoError"
            color="error"
            variant="soft"
            :title="demoError"
            class="mb-4"
          />
          <p
            v-else-if="demos.length === 0"
            class="rounded-2xl bg-elevated/40 px-6 py-12 text-center text-sm text-muted shadow-sm ring-1 ring-default/60"
          >
            No demo projects yet.
          </p>
          <div
            v-else
            class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 [&_time]:tabular-nums"
          >
            <ProjectCard
              v-for="project in cardDemos"
              :key="project.id"
              :project="project"
              :to="`/p/${project.id}`"
              :preview-columns="previewForDemo(project.id).columns"
              :preview-config="previewForDemo(project.id).config"
              :preview-construction="previewForDemo(project.id).construction"
              :show-actions="false"
              :show-date="false"
            />
          </div>
        </template>

        <div
          v-else
          class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 [&_time]:tabular-nums"
        >
          <ProjectCard
            v-for="project in localProjects"
            :key="project.id"
            :project="project"
            :preview-columns="previewForLocal(project.id).columns"
            :preview-config="previewForLocal(project.id).config"
            :preview-construction="previewForLocal(project.id).construction"
            :published="isPublished(project.id)"
            :demo="isAdmin && isDemo(project.id)"
            :admin-actions="isAdmin"
            @rename="openRename"
            @delete="openDelete"
            @toggle-pin="togglePin"
            @duplicate="duplicateProject"
            @toggle-demo="toggleDemo"
          />
        </div>
      </template>

      <template v-else>
        <div
          v-if="demoLoading"
          class="flex items-center justify-center py-16 animate-pulse"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-8 animate-spin text-muted"
          />
        </div>
        <UAlert
          v-else-if="demoError"
          color="error"
          variant="soft"
          :title="demoError"
          class="mb-4"
        />
        <p
          v-else-if="demos.length === 0"
          class="rounded-2xl bg-elevated/40 px-6 py-12 text-center text-sm text-muted shadow-sm ring-1 ring-default/60"
        >
          No demo projects yet.
        </p>
        <div
          v-else
          class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 [&_time]:tabular-nums"
        >
          <ProjectCard
            v-for="project in cardDemos"
            :key="project.id"
            :project="project"
            :to="`/p/${project.id}`"
            :preview-columns="previewForDemo(project.id).columns"
            :preview-config="previewForDemo(project.id).config"
            :preview-construction="previewForDemo(project.id).construction"
            :show-actions="false"
            :show-date="false"
          />
        </div>
      </template>
    </div>

    <AppFormDialog
      v-if="renameOpen"
      v-model:open="renameOpen"
      :title="renameDialogTitle"
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
    </AppFormDialog>

    <AppConfirmDialog
      v-if="deleteOpen"
      v-model:open="deleteOpen"
      title="Delete project?"
      :message="deleteDialogMessage"
      cancel-label="Cancel"
      confirm-label="Delete"
      @confirm="confirmDelete"
    />

    <AuthModal
      v-if="authModalOpen"
      v-model:open="authModalOpen"
    />

    <input
      ref="importInputRef"
      type="file"
      accept=".morti,application/octet-stream"
      class="sr-only"
      @change="importProject"
    >
  </UContainer>
</template>
