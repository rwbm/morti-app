export type ModuleType = 'shelf' | 'drawer' | 'doors' | 'left-door' | 'right-door'

export interface FurnitureModule {
  id: string
  type: ModuleType
  height: number // metres
  drawerCount?: number // 1..32, drawer only
  /** Interior layout, independent of the front. Missing means an empty interior. */
  interior?: { shelfCount: number }
}

export interface FurnitureColumn {
  width: number // metres
  modules: FurnitureModule[]
}

export interface FurnitureConstruction {
  leftSide: boolean
  rightSide: boolean
  top: boolean
  bottom: boolean
  back: boolean
  topMode: 'inset' | 'overlay' | 'cap'
  topOverhang: number
  legs: {
    enabled: boolean
    height: number
    width: number
    inset: number
  }
}

export interface ExteriorDimensions {
  width: number
  height: number
  depth: number
}

export type ConstructionPatch = Partial<Omit<FurnitureConstruction, 'legs'>> & {
  legs?: Partial<FurnitureConstruction['legs']>
}

export interface FurnitureConfig {
  depth: number
  panelThickness: number
  backPanelThickness: number
  doorThickness: number
  drawerFrontThickness: number
  drawerPanelThickness: number
  drawerBottomThickness: number
  panelJointClearance: number
  frontClearance: number
  sidePanelOverhang: number
  pullHoleDiameter: number
  pullHoleEdgeInset: number
  pullHolePairGap: number
  backPanelGrooveClearance: number
  drawerBottomInset: number
  drawerSlidesReserve: number
  backPanelInset: number
  minColumnWidth: number
  maxColumnWidth: number
  minModuleHeight: number
  maxModuleHeight: number
  minDrawerHeight: number
  maxDrawerHeight: number
}

export interface FurnitureDoc {
  schemaVersion: number
  lastAppliedMigrationId: string | null
  config: FurnitureConfig
  columns: FurnitureColumn[]
  construction?: FurnitureConstruction
  exterior?: ExteriorDimensions
}

export type RenderStyle = 'rendered' | 'technical'

export interface MaterialAssignment {
  /** Preset id from MATERIAL_PRESETS, or 'custom' to use the customColor hex. */
  presetId: string
  /** Hex used when presetId === 'custom'. */
  customColor: string
}

export interface PublicStyle {
  renderStyle: RenderStyle
  technical: {
    colors: {
      background: string
      grid: string
      outlines: string
      fills: string
    }
  }
  rendered: {
    colors: {
      background: string
      grid: string
      defaultPanel: string
      verticalSide: string
      horizontalDeck: string
      moduleFront: string
    }
    materials: {
      carcass: MaterialAssignment
      sides: MaterialAssignment
      deck: MaterialAssignment
      fronts: MaterialAssignment
    }
  }
}

export type ProjectVisibility = 'public' | 'private'

export interface AuthUser {
  id: string
  email: string
  verified: boolean
  email_validated_at: string
  is_admin: boolean
  created: string
  updated: string
}

export interface CloudProjectRecord {
  id: string
  collectionId: string
  collectionName: 'morti_projects'
  owner: string
  name: string
  visibility: ProjectVisibility
  client_project_id: string
  source_project_id?: string
  is_demo: boolean
  remix_count: number
  public_style: string // JSON-serialized PublicStyle
  snapshot: string // file name
  published_at?: string
  deleted_at?: string
  created: string
  updated: string
}

export interface LocalProjectRow {
  id: string
  name: string
  cloudId: string | null
  createdAt: number | string
  updatedAt: number | string
  isDemo: boolean
  pinned?: boolean
}

export type ViewMode = 'assembly' | 'cutlist' | 'style' | 'construction'

export interface CameraState {
  position: [number, number, number]
  quaternion: [number, number, number, number]
  target: [number, number, number]
}

export interface ProjectEditorStateRow {
  id: string // = projectId
  projectId?: string
  viewMode: ViewMode
  splitRatio: number
  projectDesignerSplitRatio?: number
  projectDesignerZoomPercent?: number
  selectedModuleIds?: string[]
  camera: CameraState | null
  assemblyOpenDoorsDrawers: boolean
  assemblySpaceModulesView: boolean
  moduleVolumeHelpersVisible: boolean
  renderMode: 'rendered' | 'render-debug' | 'technical'
  publicStyle: PublicStyle
  cutlistSelectedDrawingKey: string | null
}

export type PanelRole =
  | 'vertical-side'
  | 'horizontal-deck'
  | 'back-panel'
  | 'door-front'
  | 'drawer-front'
  | 'drawer-side'
  | 'drawer-back'
  | 'drawer-bottom'
  | 'leg'
  | 'top-panel'

export type OperationType = 'through-hole' | 'rail-cut'

export interface PanelOperation {
  id: string
  operationType: OperationType
  targetPanelKey: string
  face?: 'front' | 'back'
  center?: { x: number, y: number }
  // through-hole
  cx?: number
  cy?: number
  diameter?: number
  depth?: number
  through?: boolean
  // rail-cut
  x?: number
  y?: number
  width?: number
  height?: number
  length?: number
  rotation?: number
  sourceModuleId?: string
}

export interface CompiledPanel {
  key: string
  role: PanelRole
  width: number
  height: number
  thickness: number
  position: [number, number, number]
  rotation: [number, number, number]
  operations: PanelOperation[]
  orientation?: 'vertical-xy' | 'vertical-yz' | 'horizontal-xz'
  sourceModuleId?: string
  doorHinge?: 'left' | 'right'
  touchedModuleIds?: string[]
}

export interface CompiledAssemblyIssue {
  severity: 'warning' | 'error'
  code: string
  message: string
  moduleId?: string | null
  columnIndex?: number
  moduleIndex?: number
}

export interface CompiledAssembly {
  panels: CompiledPanel[]
  operations: PanelOperation[]
  issues: CompiledAssemblyIssue[]
}

export interface HardwareSpec {
  code: string
  kind:
    | 'wood-dowel'
    | 'cam-lock'
    | 'cam-bolt'
    | 'wood-screw'
    | 'euro-screw'
    | 'drawer-slide-right'
    | 'drawer-slide-left'
    | 'back-panel-clip'
    | 'adhesive-bottom-pad'
  name: string
  unit: 'piece'
  diameterMm?: number
  lengthMm?: number
  widthMm?: number
  heightMm?: number
  notes?: string
  included: boolean
  modelGlbSrc: string
  links?: { label: string; url: string }[]
  buyLinks?: { label: string; url: string }[]
}

export const PANEL_ROLE_SHORT_CODE: Record<PanelRole, string> = {
  'vertical-side': 'S',
  'horizontal-deck': 'D',
  'back-panel': 'B',
  'door-front': 'DF',
  'drawer-front': 'DRF',
  'drawer-side': 'DRS',
  'drawer-back': 'DRB',
  'drawer-bottom': 'DBM',
  leg: 'P',
  'top-panel': 'T',
}

export const DESIGN_SCHEMA_VERSION = 7
export const ASSEMBLY_COMPILER_VERSION = 6
export const TECHNICAL_RENDERER_VERSION = 1
