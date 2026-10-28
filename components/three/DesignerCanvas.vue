<script setup lang="ts">
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as Y from 'yjs'

import { compileAssembly, compilePartGeometry } from '~~/shared/domain/assembly'
import { readFurnitureDoc } from '~~/shared/yjs/doc'
import { useThemeColors, getThemeColor } from '~~/composables/useThemeColors'
import { useThreejsCanvas } from '~~/composables/useThreejsCanvas'
import {
  addOutlineExcludeAttribute,
  bakeSurfaceIdsForScene,
  SurfaceIdPalette,
} from '~~/shared/three/outline'
import { makePanelMaterial, type PanelMaterialMode, type PanelMaterialSpec } from '~~/shared/three/materials'
import { DEFAULT_CAMERA_STATE, hexColorToNumber, normalizePublicStyle } from '~~/shared/domain/defaults'
import { resolveMaterial, type CabinetPart } from '~~/shared/domain/materials'
import type { CameraState, CompiledPanel, FurnitureDoc, PanelOperation, PublicStyle } from '~~/shared/domain/types'

// ---------------------------------------------------------------------------
// Constants (mirroring Dt_x5Iy5.js module-level constants)
// ---------------------------------------------------------------------------

const SKYDOME_RADIUS = 10
const ORBIT_MIN_POLAR_DEG = 8
const ORBIT_MAX_POLAR_DEG = 88
const DESIGNER_ORBIT_MIN_DISTANCE_M = 8
const DOOR_SWING_RAD = (62 * Math.PI) / 180
const SPACE_LS = 0.032
const SPACE_VH = 0.022
const SPACE_HH = -0.0325
const SPACE_GH = 0.095
const FIT_MULTIPLIER = 1.12
const FIT_MULTIPLIER_MOBILE = 1.25
const FRAME_LERP_TAU = 10
const GIZMO_SIZE_PX = 80
const GIZMO_CONTENT_SCALE = 1.12
const DESIGNER_WHEEL_ZOOM_MAX_DISTANCE_RATIO = 4.5
const DESIGNER_WHEEL_ZOOM_MAX_DISTANCE_RATIO_MOBILE = 6
const DESIGNER_WHEEL_ZOOM_MIN_DISTANCE_RATIO_MOBILE = 0.5
const MOBILE_VIEWPORT_MAX_WIDTH_PX = 768
const DESIGNER_WHEEL_ZOOM_SENSITIVITY = 0.0011
const GRID_FADE_OUT_SECONDS = 0.14
const GRID_FADE_IN_SECONDS = 0.35
const GRID_VISIBILITY_EPSILON = 0.01
const FLOOR_SHADOW_OPACITY = 0.28
const POSITION_SETTLE_EPSILON_SQ = 1e-8
const ROTATION_SETTLE_EPSILON = 1e-5
const TECHNICAL_OVERLAY_OFFSET = 6e-4
const TECHNICAL_HOLE_SEGMENTS = 32

interface ViewHelperOptions {
  viewportPixels?: number
  contentScale?: number
  axisColors?: {
    x?: string
    y?: string
    z?: string
  }
}

class EditorViewHelper extends THREE.Object3D {
  isViewHelper = true
  animating = false
  center = new THREE.Vector3()
  location = { top: null as number | null, right: 0, bottom: 0, left: null as number | null }

  private readonly helperCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 4)
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly pickables: THREE.Sprite[] = []
  private readonly axisGeometry: THREE.CylinderGeometry
  private readonly axisMeshes: THREE.Mesh[] = []
  private readonly workingDirection = new THREE.Vector3()
  private readonly targetPosition = new THREE.Vector3()
  private readonly targetQuaternion = new THREE.Quaternion()
  private readonly startQuaternion = new THREE.Quaternion()
  private readonly endQuaternion = new THREE.Quaternion()
  private readonly lookTarget = new THREE.Object3D()
  private readonly previousViewport = new THREE.Vector4()
  private distance = 0
  private readonly viewportPixels: number
  private readonly canvas: HTMLCanvasElement
  private readonly mainCamera: THREE.PerspectiveCamera

  constructor(mainCamera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, options?: ViewHelperOptions) {
    super()
    this.mainCamera = mainCamera
    this.canvas = canvas
    this.viewportPixels = options?.viewportPixels ?? 96

    const contentScale = options?.contentScale ?? 1
    if (contentScale !== 1) this.scale.setScalar(contentScale)

    this.helperCamera.position.set(0, 0, 2)
    this.helperCamera.lookAt(0, 0, 0)

    const xColor = this.safeColor(options?.axisColors?.x, '#ff4466')
    const yColor = this.safeColor(options?.axisColors?.y, '#88ff44')
    const zColor = this.safeColor(options?.axisColors?.z, '#4488ff')
    const dim = 0.42

    this.axisGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.8, 5)
      .rotateZ(-Math.PI / 2)
      .translate(0.4, 0, 0)

    const axisX = new THREE.Mesh(this.axisGeometry, this.axisMaterial(xColor))
    const axisY = new THREE.Mesh(this.axisGeometry, this.axisMaterial(yColor))
    const axisZ = new THREE.Mesh(this.axisGeometry, this.axisMaterial(zColor))
    axisY.rotation.z = Math.PI / 2
    axisZ.rotation.y = -Math.PI / 2
    this.axisMeshes.push(axisX, axisY, axisZ)
    this.add(axisX, axisZ, axisY)

    const posX = this.makeSprite(xColor, 'posX')
    const posY = this.makeSprite(yColor, 'posY')
    const posZ = this.makeSprite(zColor, 'posZ')
    const negX = this.makeSprite(xColor.clone().multiplyScalar(dim), 'negX')
    const negY = this.makeSprite(yColor.clone().multiplyScalar(dim), 'negY')
    const negZ = this.makeSprite(zColor.clone().multiplyScalar(dim), 'negZ')

    posX.position.x = 1
    posY.position.y = 1
    posZ.position.z = 1
    negX.position.x = -1
    negY.position.y = -1
    negZ.position.z = -1
    for (const sprite of [posX, posY, posZ, negX, negY, negZ]) {
      sprite.renderOrder = 1
      this.pickables.push(sprite)
      this.add(sprite)
    }
  }

  render(renderer: THREE.WebGLRenderer) {
    this.quaternion.copy(this.mainCamera.quaternion).invert()
    this.updateMatrixWorld(true)

    const loc = this.location
    const left = loc.left !== null ? loc.left : this.canvas.offsetWidth - this.viewportPixels - loc.right
    const bottom = loc.top !== null ? this.canvas.offsetHeight - this.viewportPixels - loc.top : loc.bottom

    renderer.clearDepth()
    renderer.getViewport(this.previousViewport)
    renderer.setViewport(left, bottom, this.viewportPixels, this.viewportPixels)
    renderer.render(this, this.helperCamera)
    renderer.setViewport(this.previousViewport)
  }

  handleClick(event: PointerEvent): boolean {
    if (this.animating) return false

    const rect = this.canvas.getBoundingClientRect()
    const loc = this.location
    const left = loc.left !== null ? rect.left + loc.left : rect.left + this.canvas.offsetWidth - this.viewportPixels - loc.right
    const top = loc.top !== null ? rect.top + loc.top : rect.top + this.canvas.offsetHeight - this.viewportPixels - loc.bottom

    this.pointer.x = ((event.clientX - left) / this.viewportPixels) * 2 - 1
    this.pointer.y = -((event.clientY - top) / this.viewportPixels) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.helperCamera)

    const hit = this.raycaster.intersectObjects(this.pickables)[0]?.object as THREE.Sprite | undefined
    if (!hit) return false

    this.prepareAnimation(hit, this.center)
    this.animating = true
    return true
  }

  update(dt: number) {
    const step = dt * Math.PI * 2
    this.startQuaternion.rotateTowards(this.endQuaternion, step)
    this.mainCamera.position
      .set(0, 0, 1)
      .applyQuaternion(this.startQuaternion)
      .multiplyScalar(this.distance)
      .add(this.center)
    this.mainCamera.quaternion.rotateTowards(this.targetQuaternion, step)
    if (this.startQuaternion.angleTo(this.endQuaternion) === 0) this.animating = false
  }

  dispose() {
    this.axisGeometry.dispose()
    for (const mesh of this.axisMeshes) {
      const mat = mesh.material as THREE.Material
      mat.dispose()
    }
    for (const sprite of this.pickables) {
      const mat = sprite.material as THREE.SpriteMaterial
      mat.map?.dispose()
      mat.dispose()
    }
  }

  private prepareAnimation(sprite: THREE.Sprite, center: THREE.Vector3) {
    switch (sprite.userData.type) {
      case 'posX':
        this.workingDirection.set(1, 0, 0)
        this.targetQuaternion.setFromEuler(new THREE.Euler(0, Math.PI * 0.5, 0))
        break
      case 'posY':
        this.workingDirection.set(0, 1, 0)
        this.targetQuaternion.setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, 0))
        break
      case 'posZ':
        this.workingDirection.set(0, 0, 1)
        this.targetQuaternion.setFromEuler(new THREE.Euler())
        break
      case 'negX':
        this.workingDirection.set(-1, 0, 0)
        this.targetQuaternion.setFromEuler(new THREE.Euler(0, -Math.PI * 0.5, 0))
        break
      case 'negY':
        this.workingDirection.set(0, -1, 0)
        this.targetQuaternion.setFromEuler(new THREE.Euler(Math.PI * 0.5, 0, 0))
        break
      case 'negZ':
        this.workingDirection.set(0, 0, -1)
        this.targetQuaternion.setFromEuler(new THREE.Euler(0, Math.PI, 0))
        break
      default:
        console.error('EditorViewHelper: Invalid axis.')
    }

    this.distance = this.mainCamera.position.distanceTo(center)
    this.targetPosition.copy(this.workingDirection).multiplyScalar(this.distance).add(center)
    this.lookTarget.position.copy(center)
    this.lookTarget.lookAt(this.mainCamera.position)
    this.startQuaternion.copy(this.lookTarget.quaternion)
    this.lookTarget.lookAt(this.targetPosition)
    this.endQuaternion.copy(this.lookTarget.quaternion)
  }

  private axisMaterial(color: THREE.Color) {
    return new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: true, depthWrite: true })
  }

  private makeSprite(color: THREE.Color, type: string) {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.beginPath()
      ctx.arc(32, 32, 14, 0, Math.PI * 2)
      ctx.closePath()
      ctx.fillStyle = color.getStyle()
      ctx.fill()
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, toneMapped: false, depthTest: false, depthWrite: false }))
    sprite.userData.type = type
    return sprite
  }

  private safeColor(value: string | undefined, fallback: string) {
    const color = new THREE.Color(fallback)
    if (!value || /oklch|oklab|color\(/i.test(value)) return color
    try {
      color.setStyle(value)
    }
    catch {
      color.setStyle(fallback)
    }
    return color
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  ydoc?: Y.Doc | null
  doc?: Y.Doc | null
  assemblyOpenDoorsDrawers?: boolean
  assemblySpaceModulesView?: boolean
  moduleVolumeHelpersVisible?: boolean
  renderMode?: 'rendered' | 'render-debug' | 'technical'
  selectedModuleIds?: string[]
  initialCameraState?: CameraState | null
  publicStyle: PublicStyle
  canvasChromeTeleportSelector?: string | null
  headlessCapture?: boolean
  captureYawRadians?: number
}

const props = withDefaults(defineProps<Props>(), {
  ydoc: null,
  doc: null,
  assemblyOpenDoorsDrawers: false,
  assemblySpaceModulesView: false,
  moduleVolumeHelpersVisible: false,
  renderMode: 'render-debug',
  selectedModuleIds: () => [],
  initialCameraState: null,
  canvasChromeTeleportSelector: null,
  headlessCapture: false,
  captureYawRadians: 0,
})

const emit = defineEmits<{
  (e: 'camera-change', state: CameraState): void
  (e: 'update:assemblyOpenDoorsDrawers', value: boolean): void
  (e: 'update:assemblySpaceModulesView', value: boolean): void
  (e: 'update:moduleVolumeHelpersVisible', value: boolean): void
  (e: 'update:renderMode', value: Props['renderMode']): void
}>()

// ---------------------------------------------------------------------------
// Refs / Three.js scene
// ---------------------------------------------------------------------------

const wrapperRef = ref<HTMLElement | null>(null)
const mainCanvasWrapperRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const gizmoWrapperRef = ref<HTMLElement | null>(null)
const gizmoCanvasRef = ref<HTMLCanvasElement | null>(null)
const { colors } = useThemeColors()
const activeDoc = computed(() => props.ydoc ?? props.doc)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 100)
camera.position.set(2.2, 1.8, 2.2)
camera.lookAt(0, 0, 0)

const panelGroup = new THREE.Group()
scene.add(panelGroup)

// Lighting
const ambient = new THREE.AmbientLight(0xffffff, 0.4)
scene.add(ambient)
const keyLight = new THREE.DirectionalLight(0xffffff, 1.15)
keyLight.position.set(4, 6, 3)
keyLight.target.position.set(0, 0, 0)
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.bias = -0.00015
keyLight.shadow.normalBias = 0.045
keyLight.shadow.radius = 2
keyLight.shadow.camera.left = -10
keyLight.shadow.camera.right = 10
keyLight.shadow.camera.top = 10
keyLight.shadow.camera.bottom = -10
keyLight.shadow.camera.near = 0.08
keyLight.shadow.camera.far = 42
keyLight.castShadow = false
scene.add(keyLight)
scene.add(keyLight.target)

const hemisphereGroup = new THREE.Group()
hemisphereGroup.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2))

// Skydome (always hidden per spec)
const skydomeMat = new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.BackSide, depthWrite: false })
const skydome = new THREE.Mesh(new THREE.SphereGeometry(SKYDOME_RADIUS, 48, 24), skydomeMat)
skydome.frustumCulled = false
skydome.renderOrder = -1000
skydome.visible = false
scene.add(skydome)

// DotsGrid (procedural, matching the compiled per-vertex alpha falloff)
const dotsGroup = new THREE.Group()

function disposeObjectMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    for (const mat of material) mat.dispose()
  }
  else {
    material.dispose()
  }
}

function disposeObjectTree(object: THREE.Object3D) {
  object.traverse((child) => {
    const geometry = (child as THREE.Mesh | THREE.LineSegments).geometry
    if (geometry) geometry.dispose()
    const material = (child as THREE.Mesh | THREE.LineSegments).material
    if (material) disposeObjectMaterial(material)
  })
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

let dotsGridOpacity: number | null = null

function applyDotsGridOpacity(opacity: number) {
  for (const child of dotsGroup.children) {
    const material = (child as THREE.Mesh).material
    if (Array.isArray(material)) {
      for (const mat of material) mat.opacity = opacity
    }
    else if (material) {
      material.opacity = opacity
    }
  }
  dotsGroup.visible = opacity > GRID_VISIBILITY_EPSILON
}

function tickSceneGroundOpacity(dt: number) {
  const target = props.assemblySpaceModulesView ? 0 : 1
  if (dotsGridOpacity === null) {
    dotsGridOpacity = target
  }
  else if (dt > 0) {
    const duration = dotsGridOpacity > target ? GRID_FADE_OUT_SECONDS : GRID_FADE_IN_SECONDS
    const step = (dt / duration)
    if (dotsGridOpacity < target) dotsGridOpacity = Math.min(target, dotsGridOpacity + step)
    else if (dotsGridOpacity > target) dotsGridOpacity = Math.max(target, dotsGridOpacity - step)
  }
  const opacity = dotsGridOpacity
  applyDotsGridOpacity(opacity)
  floorCatcherMaterial.opacity = FLOOR_SHADOW_OPACITY * opacity
  floorCatcher.visible = props.renderMode === 'render-debug' && opacity > GRID_VISIBILITY_EPSILON
}

function buildDotsGrid(color: number) {
  while (dotsGroup.children.length > 0) {
    const c = dotsGroup.children[0]
    dotsGroup.remove(c)
    if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose()
    const material = (c as THREE.Mesh).material
    if (material) disposeObjectMaterial(material)
  }
  const gap = 0.18
  const dotRadius = 0.01
  const falloffStart = 1
  const falloffEnd = 2
  const limit = Math.floor(falloffEnd / gap)
  const segments = Math.max(8, Math.min(24, Math.ceil(dotRadius * 48)))
  const geometries: THREE.BufferGeometry[] = []
  for (let l = -limit; l <= limit; l++) {
    for (let d = -limit; d <= limit; d++) {
      const px = d * gap
      const pz = l * gap
      const radius = Math.hypot(px, pz)
      const alpha = 1 - smoothstep(falloffStart, falloffEnd, radius)
      if (alpha <= 0) continue
      const geometry = new THREE.CircleGeometry(dotRadius, segments)
      geometry.translate(px, pz, 0)
      const count = geometry.getAttribute('position').count
      const vertexColors = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        const offset = i * 4
        vertexColors[offset] = 1
        vertexColors[offset + 1] = 1
        vertexColors[offset + 2] = 1
        vertexColors[offset + 3] = alpha
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 4))
      geometries.push(geometry)
    }
  }
  const merged = mergeGeometries(geometries, false)
  for (const geometry of geometries) geometry.dispose()
  if (!merged) return
  addOutlineExcludeAttribute(merged, 1)
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    opacity: 1,
  })
  dotsGroup.add(new THREE.Mesh(merged, mat))
  applyDotsGridOpacity(dotsGridOpacity ?? (props.assemblySpaceModulesView ? 0 : 1))
}
buildDotsGrid(getThemeColor('neutral500').hex)
dotsGroup.rotation.x = -Math.PI / 2
dotsGroup.position.y = -0.008
scene.add(dotsGroup)

// Floor shadow catcher
const floorCatcherMaterial = new THREE.ShadowMaterial({ opacity: FLOOR_SHADOW_OPACITY, transparent: true, depthWrite: false })
const floorCatcher = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), floorCatcherMaterial)
floorCatcher.rotation.x = -Math.PI / 2
floorCatcher.position.y = -0.012
floorCatcher.receiveShadow = true
floorCatcher.castShadow = false
floorCatcher.visible = false
scene.add(floorCatcher)

// ---------------------------------------------------------------------------
// Tracking maps
// ---------------------------------------------------------------------------

interface TrackedPanel {
  group: THREE.Group
  mesh: THREE.Mesh
  panel: CompiledPanel
  basePosition: THREE.Vector3
  baseQuaternion: THREE.Quaternion
  targetPosition: THREE.Vector3
  targetQuaternion: THREE.Quaternion
}

const tracked = new Map<string, TrackedPanel>()
const surfacePalette = new SurfaceIdPalette()
let cabinetDepthForTargets = 0.45

interface PanelPose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

interface BuildSceneOptions {
  preservePanelTransforms?: boolean
}

// ---------------------------------------------------------------------------
// Compile + sync panels
// ---------------------------------------------------------------------------

function readDoc(): FurnitureDoc | null {
  if (!activeDoc.value) return null
  return readFurnitureDoc(activeDoc.value)
}

function panelMaterialMode(): PanelMaterialMode {
  // 'rendered' is the default user-facing mode — solid lit wood panels.
  // 'render-debug' colours each role for debugging.
  // 'technical' uses flat fills; outlines are applied by the postprocess pass.
  if (props.renderMode === 'technical') return 'unlit'
  return 'shaded'
}

function hexFromString(s: string | undefined, fallback: number): number {
  return hexColorToNumber(s, fallback)
}

const resolvedPublicStyle = computed<PublicStyle>(() => {
  return normalizePublicStyle(props.publicStyle)
})

const canvasBackgroundColor = computed(() =>
  props.renderMode === 'technical'
    ? resolvedPublicStyle.value.technical.colors.background
    : resolvedPublicStyle.value.rendered.colors.background,
)

const gridColor = computed(() => {
  if (props.renderMode === 'technical') return resolvedPublicStyle.value.technical.colors.grid
  if (props.renderMode === 'render-debug') return resolvedPublicStyle.value.rendered.colors.grid
  return `#${getThemeColor('neutral500').hex.toString(16).padStart(6, '0')}`
})

function partForPanel(panel: CompiledPanel): CabinetPart {
  if (panel.role === 'vertical-side') return 'sides'
  if (panel.role === 'horizontal-deck' || panel.role === 'top-panel') return 'deck'
  if (panel.role === 'door-front' || panel.role === 'drawer-front') return 'fronts'
  return 'carcass'
}

function legacyHexForPart(part: CabinetPart): string {
  const rendered = resolvedPublicStyle.value.rendered.colors
  if (part === 'sides') return rendered.verticalSide
  if (part === 'deck') return rendered.horizontalDeck
  if (part === 'fronts') return rendered.moduleFront
  return rendered.defaultPanel
}

function panelMaterialSpec(panel: CompiledPanel): PanelMaterialSpec {
  if (props.renderMode === 'technical') {
    return { color: hexFromString(resolvedPublicStyle.value.technical.colors.fills, 0x1c1917) }
  }

  // Both `render-debug` and `rendered` resolve through the per-part material
  // assignment. (In Style view `canvasRenderMode` only ever yields
  // `render-debug` or `technical` — see pages/project/[id].vue:96-100 — so
  // gating materials behind `'rendered'` would make the picker invisible.)
  const part = partForPanel(panel)
  const fallbackHex = legacyHexForPart(part)
  const assignment = resolvedPublicStyle.value.rendered.materials[part]
  const resolved = resolveMaterial(assignment.presetId, assignment.customColor, fallbackHex)

  return {
    color: hexFromString(resolved.hex, 0xaaaaaa),
    roughness: resolved.roughness,
    metalness: resolved.metalness,
    grain: resolved.grain,
  }
}

function panelColor(panel: CompiledPanel): number {
  return panelMaterialSpec(panel).color
}

function addSolidColorAttribute(geometry: THREE.BufferGeometry, color = 0xf5f5f5) {
  const position = geometry.getAttribute('position')
  if (!position) return
  const threeColor = new THREE.Color(color)
  const values = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    const offset = i * 3
    values[offset] = threeColor.r
    values[offset + 1] = threeColor.g
    values[offset + 2] = threeColor.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3))
  addOutlineExcludeAttribute(geometry, 0)
}

function makeTechnicalLineMaterial(color: number) {
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    depthTest: true,
    depthWrite: true,
  })
  material.toneMapped = false
  return material
}

function makeHoleOutlineGeometry(diameter: number, segments = TECHNICAL_HOLE_SEGMENTS) {
  const radius = Math.max(0.0005, diameter) / 2
  const count = Math.max(8, Math.floor(segments))
  const positions: number[] = []
  for (let i = 0; i < count; i++) {
    const a0 = (i / count) * Math.PI * 2
    const a1 = ((i + 1) / count) * Math.PI * 2
    positions.push(
      Math.cos(a0) * radius, Math.sin(a0) * radius, 0,
      Math.cos(a1) * radius, Math.sin(a1) * radius, 0,
    )
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  addSolidColorAttribute(geometry)
  return geometry
}

function makeRailCutOutlineGeometry(length: number, width: number) {
  const halfLength = Math.max(0.0005, length) / 2
  const halfWidth = Math.max(0.0005, width) / 2
  const positions = new Float32Array([
    -halfLength, -halfWidth, 0,
    halfLength, -halfWidth, 0,
    halfLength, -halfWidth, 0,
    halfLength, halfWidth, 0,
    halfLength, halfWidth, 0,
    -halfLength, halfWidth, 0,
    -halfLength, halfWidth, 0,
    -halfLength, -halfWidth, 0,
  ])
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  addSolidColorAttribute(geometry)
  return geometry
}

function operationCenter(op: PanelOperation) {
  return {
    x: op.center?.x ?? op.cx ?? op.x ?? 0,
    y: op.center?.y ?? op.cy ?? op.y ?? 0,
  }
}

function addThroughHoleOverlay(group: THREE.Group, panel: CompiledPanel, op: PanelOperation, color: number) {
  const diameter = op.diameter ?? 0
  if (diameter <= 0) return
  const center = operationCenter(op)
  const geometry = makeHoleOutlineGeometry(diameter)
  const line = new THREE.LineSegments(geometry, makeTechnicalLineMaterial(color))
  const sign = op.face === 'back' ? -1 : 1
  line.position.set(center.x, center.y, sign * (panel.thickness / 2 + TECHNICAL_OVERLAY_OFFSET))
  if (sign < 0) line.rotation.y = Math.PI
  line.userData.technicalOperationOverlay = true
  group.add(line)
}

function addRailCutOverlay(group: THREE.Group, panel: CompiledPanel, op: PanelOperation, color: number) {
  const length = op.length ?? op.width ?? 0
  const width = op.length !== undefined ? (op.width ?? 0) : (op.height ?? 0)
  if (length <= 0 || width <= 0) return
  const center = operationCenter(op)
  const geometry = makeRailCutOutlineGeometry(length, width)
  const line = new THREE.LineSegments(geometry, makeTechnicalLineMaterial(color))
  line.userData.technicalOperationOverlay = true

  const sign = op.face === 'back' ? -1 : 1
  line.position.set(center.x, center.y, sign * (panel.thickness / 2 + TECHNICAL_OVERLAY_OFFSET))
  if (sign < 0) line.rotation.y = Math.PI
  if (op.rotation && Math.abs(op.rotation) > 1e-9) line.rotation.z = op.rotation

  group.add(line)
}

function addTechnicalOperationOverlays(group: THREE.Group, panel: CompiledPanel, operations: PanelOperation[]) {
  const overlayColor = colors.value.textDefault.hex
  for (const op of operations) {
    if (op.targetPanelKey !== panel.key) continue
    if (op.operationType === 'through-hole') addThroughHoleOverlay(group, panel, op, overlayColor)
    else if (op.operationType === 'rail-cut') addRailCutOverlay(group, panel, op, overlayColor)
  }
}

function clearTracked() {
  for (const t of tracked.values()) {
    panelGroup.remove(t.group)
    disposeObjectTree(t.group)
  }
  tracked.clear()
}

function capturePanelPoses(): Map<string, PanelPose> {
  const poses = new Map<string, PanelPose>()
  for (const [key, panel] of tracked) {
    poses.set(key, {
      position: panel.group.position.clone(),
      quaternion: panel.group.quaternion.clone(),
    })
  }
  return poses
}

function settleTrackedToTargets() {
  for (const t of tracked.values()) {
    t.group.position.copy(t.targetPosition)
    t.group.quaternion.copy(t.targetQuaternion)
  }
}

function buildScene(options: BuildSceneOptions = {}) {
  const previousPoses = options.preservePanelTransforms ? capturePanelPoses() : null
  clearTracked()
  const fd = readDoc()
  if (!fd) return
  cabinetDepthForTargets = fd.config.depth
  const compiled = compileAssembly(fd)
  for (const panel of compiled.panels) {
    const group = new THREE.Group()
    const geometry = compilePartGeometry(panel, compiled.operations)
    addOutlineExcludeAttribute(geometry, 0)
    const material = makePanelMaterial(panelMaterialMode(), panelMaterialSpec(panel))
    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = panelMaterialMode() === 'shaded'
    mesh.receiveShadow = panelMaterialMode() === 'shaded'
    mesh.name = panel.key
    group.add(mesh)
    if (props.renderMode === 'technical') {
      addTechnicalOperationOverlays(group, panel, compiled.operations)
    }
    group.position.set(panel.position[0], panel.position[1], panel.position[2])
    group.rotation.set(panel.rotation[0], panel.rotation[1], panel.rotation[2])
    panelGroup.add(group)
    tracked.set(panel.key, {
      group,
      mesh,
      panel,
      basePosition: new THREE.Vector3(panel.position[0], panel.position[1], panel.position[2]),
      baseQuaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(panel.rotation[0], panel.rotation[1], panel.rotation[2])),
      targetPosition: new THREE.Vector3(panel.position[0], panel.position[1], panel.position[2]),
      targetQuaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(panel.rotation[0], panel.rotation[1], panel.rotation[2])),
    })
  }
  if (props.renderMode === 'technical') {
    surfacePalette.reset()
    bakeSurfaceIdsForScene(panelGroup, { palette: surfacePalette })
  }
  recomputeTargets()
  if (previousPoses) {
    for (const [key, t] of tracked) {
      const pose = previousPoses.get(key)
      if (pose) {
        t.group.position.copy(pose.position)
        t.group.quaternion.copy(pose.quaternion)
      }
      else {
        t.group.position.copy(t.targetPosition)
        t.group.quaternion.copy(t.targetQuaternion)
      }
    }
  }
  else {
    settleTrackedToTargets()
  }
}

// ---------------------------------------------------------------------------
// Door swing + drawer pull + space-modules animation targets
// ---------------------------------------------------------------------------

function isLeftDoorPanel(panel: CompiledPanel): boolean {
  if (panel.doorHinge) return panel.doorHinge === 'left'
  return /(?:-|:)left$/.test(panel.key)
}

function drawerInfo(panelKey: string) {
  if (
    !panelKey.startsWith('drawer-front:')
    && !panelKey.startsWith('drawer-side:')
    && !panelKey.startsWith('drawer-back:')
    && !panelKey.startsWith('drawer-bottom:')
  ) return null
  const parts = panelKey.split(':')
  if (parts.length < 3) return null
  const drawerIndex = Number.parseInt(parts[2] ?? '', 10)
  if (!Number.isFinite(drawerIndex) || drawerIndex < 0) return null
  return { moduleId: parts[1], drawerIndex }
}

function drawerCountsByModule(panels: Iterable<CompiledPanel>) {
  const maxIndexByModule = new Map<string, number>()
  for (const panel of panels) {
    const info = drawerInfo(panel.key)
    if (!info) continue
    maxIndexByModule.set(info.moduleId, Math.max(maxIndexByModule.get(info.moduleId) ?? -1, info.drawerIndex))
  }
  const counts = new Map<string, number>()
  for (const [moduleId, maxIndex] of maxIndexByModule) counts.set(moduleId, maxIndex + 1)
  return counts
}

function drawerOpenScale(drawerIndex: number, drawerCount: number) {
  if (drawerCount <= 1) return 1
  return 1 - (drawerIndex / (drawerCount - 1)) * (1 - 0.32)
}

function drawerOpenOffset(panel: CompiledPanel, open: boolean, drawerCounts: Map<string, number>) {
  if (!open) return 0
  if (
    panel.role !== 'drawer-front'
    && panel.role !== 'drawer-side'
    && panel.role !== 'drawer-back'
    && panel.role !== 'drawer-bottom'
  ) return 0
  const baseOffset = Math.max(0.01, cabinetDepthForTargets) * 0.75
  const info = drawerInfo(panel.key)
  if (!info) return baseOffset
  return baseOffset * drawerOpenScale(info.drawerIndex, drawerCounts.get(info.moduleId) ?? 1)
}

function verticalBoundaryIndex(panelKey: string) {
  const match = /^vertical:boundary:(\d+)$/.exec(panelKey)
  if (!match) return null
  const index = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(index) ? index : null
}

function horizontalBoundaryInfo(panelKey: string) {
  const match = /^horizontal:column:(\d+):boundary:(\d+)$/.exec(panelKey)
  if (!match) return null
  const columnIndex = Number.parseInt(match[1] ?? '', 10)
  const boundaryIndex = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isFinite(columnIndex) || !Number.isFinite(boundaryIndex)) return null
  return { columnIndex, boundaryIndex }
}

function backPanelColumnIndex(panelKey: string) {
  const match = /^back:column:(\d+):module:/.exec(panelKey)
  if (!match) return null
  const columnIndex = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(columnIndex) ? columnIndex : null
}

function maxVerticalBoundaryIndex(panels: Iterable<CompiledPanel>) {
  let maxIndex = 0
  for (const panel of panels) {
    const index = verticalBoundaryIndex(panel.key)
    if (index != null) maxIndex = Math.max(maxIndex, index)
  }
  return maxIndex
}

function maxHorizontalBoundaryByColumn(panels: Iterable<CompiledPanel>) {
  const result = new Map<number, number>()
  for (const panel of panels) {
    const info = horizontalBoundaryInfo(panel.key)
    if (!info) continue
    result.set(info.columnIndex, Math.max(result.get(info.columnIndex) ?? 0, info.boundaryIndex))
  }
  return result
}

function sourceModuleColumnMap(panels: Iterable<CompiledPanel>) {
  const result = new Map<string, number>()
  for (const panel of panels) {
    if (panel.role !== 'back-panel' || !panel.sourceModuleId) continue
    const columnIndex = backPanelColumnIndex(panel.key)
    if (columnIndex != null) result.set(panel.sourceModuleId, columnIndex)
  }
  return result
}

function columnSpreadOffset(columnIndex: number, maxBoundaryIndex: number) {
  if (maxBoundaryIndex <= 0) return 0
  const half = maxBoundaryIndex * 0.5
  return (columnIndex + 0.5 - half) * SPACE_LS
}

function spaceModulesOffset(
  panel: CompiledPanel,
  maxBoundaryIndex: number,
  horizontalBoundaryMaxByColumn: Map<number, number>,
  moduleColumnBySource: Map<string, number>,
) {
  let dx = 0
  let dy = 0
  let dz = 0
  const verticalIndex = verticalBoundaryIndex(panel.key)
  if (verticalIndex != null && maxBoundaryIndex > 0) {
    const half = maxBoundaryIndex * 0.5
    dx = (verticalIndex - half) * SPACE_LS
  }

  const horizontalInfo = horizontalBoundaryInfo(panel.key)
  if (horizontalInfo) {
    if (maxBoundaryIndex > 0) dx += columnSpreadOffset(horizontalInfo.columnIndex, maxBoundaryIndex)
    const maxBoundaryForColumn = horizontalBoundaryMaxByColumn.get(horizontalInfo.columnIndex) ?? 0
    if (maxBoundaryForColumn >= 1) {
      const half = maxBoundaryForColumn * 0.5
      dy = (horizontalInfo.boundaryIndex - half) * SPACE_VH
    }
  }

  if (panel.role === 'back-panel') {
    dz += SPACE_HH
    if (maxBoundaryIndex > 0) {
      const columnIndex = backPanelColumnIndex(panel.key) ?? (panel.sourceModuleId ? moduleColumnBySource.get(panel.sourceModuleId) : undefined)
      if (columnIndex != null) dx += columnSpreadOffset(columnIndex, maxBoundaryIndex)
    }
  }
  else if (panel.sourceModuleId) {
    dz += SPACE_GH
    if (maxBoundaryIndex > 0) {
      const columnIndex = moduleColumnBySource.get(panel.sourceModuleId)
      if (columnIndex != null) dx += columnSpreadOffset(columnIndex, maxBoundaryIndex)
    }
  }

  return { dx, dy, dz }
}

function recomputeTargets() {
  const open = props.assemblyOpenDoorsDrawers && !props.assemblySpaceModulesView
  const space = props.assemblySpaceModulesView
  const panels = [...tracked.values()].map(t => t.panel)
  const drawerCounts = drawerCountsByModule(panels)
  const maxBoundaryIndex = maxVerticalBoundaryIndex(panels)
  const horizontalBoundaryMaxByColumn = maxHorizontalBoundaryByColumn(panels)
  const moduleColumnBySource = sourceModuleColumnMap(panels)

  for (const t of tracked.values()) {
    const p = t.panel
    t.targetPosition.copy(t.basePosition)
    t.targetQuaternion.copy(t.baseQuaternion)

    // Door swing
    if (open && p.role === 'door-front') {
      const isLeft = isLeftDoorPanel(p)
      const angle = isLeft ? -DOOR_SWING_RAD : DOOR_SWING_RAD
      const halfW = p.width / 2
      const hingeX = isLeft ? t.basePosition.x - halfW : t.basePosition.x + halfW
      const pivot = new THREE.Vector3(hingeX, t.basePosition.y, t.basePosition.z)
      const vec = new THREE.Vector3().subVectors(t.basePosition, pivot)
      const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle)
      vec.applyQuaternion(rot)
      t.targetPosition.copy(pivot).add(vec)
      t.targetQuaternion.copy(rot).multiply(t.baseQuaternion)
    }

    // Drawer pull
    t.targetPosition.z += drawerOpenOffset(p, open, drawerCounts)

    // Space-modules layout offsets — apply to all panels touching that column/module.
    if (space) {
      const { dx, dy, dz } = spaceModulesOffset(p, maxBoundaryIndex, horizontalBoundaryMaxByColumn, moduleColumnBySource)
      t.targetPosition.x += dx
      t.targetPosition.y += dy
      t.targetPosition.z += dz
    }
  }
}

function tickAnimations(dt: number) {
  const a = Math.min(1, 1 - Math.exp(-FRAME_LERP_TAU * dt))
  for (const t of tracked.values()) {
    const distSq = t.group.position.distanceToSquared(t.targetPosition)
    if (distSq > POSITION_SETTLE_EPSILON_SQ) {
      t.group.position.lerp(t.targetPosition, a)
      if (t.group.position.distanceToSquared(t.targetPosition) <= POSITION_SETTLE_EPSILON_SQ) {
        t.group.position.copy(t.targetPosition)
      }
    }
    else {
      t.group.position.copy(t.targetPosition)
    }
    const angle = t.group.quaternion.angleTo(t.targetQuaternion)
    if (angle > ROTATION_SETTLE_EPSILON) {
      t.group.quaternion.slerp(t.targetQuaternion, a)
      if (t.group.quaternion.angleTo(t.targetQuaternion) <= ROTATION_SETTLE_EPSILON) {
        t.group.quaternion.copy(t.targetQuaternion)
      }
    }
    else {
      t.group.quaternion.copy(t.targetQuaternion)
    }
  }
}

// ---------------------------------------------------------------------------
// OrbitControls
// ---------------------------------------------------------------------------

let controls: OrbitControls | null = null
let controlsDomElement: HTMLElement | null = null
let cameraChangeTimer: number | null = null
let wheelZoomDistanceRatio = 1
let lastFitCenterY = 0
let suppressCameraChange = false
let lastEmittedCameraStateKey = ''

function cameraStateKey(cs: CameraState | null | undefined) {
  if (!cs) return 'null'
  return [...cs.position, ...cs.quaternion, ...cs.target]
    .map(value => Number.isFinite(value) ? value.toFixed(6) : 'NaN')
    .join(',')
}

function currentCameraState(): CameraState {
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
    target: controls
      ? [controls.target.x, controls.target.y, controls.target.z]
      : [0, 0, 0],
  }
}

function emitCameraChange() {
  const state = currentCameraState()
  lastEmittedCameraStateKey = cameraStateKey(state)
  emit('camera-change', state)
}

function debouncedEmitCameraChange() {
  if (suppressCameraChange) return
  if (cameraChangeTimer !== null) window.clearTimeout(cameraChangeTimer)
  cameraChangeTimer = window.setTimeout(emitCameraChange, 250)
}

function onControlsChange() {
  if (suppressCameraChange) return
  debouncedEmitCameraChange()
}

function attachControls() {
  const domElement = wrapperRef.value ?? canvasRef.value
  if (controls || !domElement) return
  controlsDomElement = domElement
  controls = new OrbitControls(camera, domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.enablePan = false
  controls.enableZoom = false
  controls.minPolarAngle = (ORBIT_MIN_POLAR_DEG * Math.PI) / 180
  controls.maxPolarAngle = (ORBIT_MAX_POLAR_DEG * Math.PI) / 180
  controls.target.set(0, 0, 0)
  controls.addEventListener('change', onControlsChange)
  controls.addEventListener('end', emitCameraChange)
  controlsDomElement.addEventListener('wheel', onCanvasWheel, { passive: false })
  controlsDomElement.addEventListener('touchstart', onCanvasTouchStart, { passive: false })
  controlsDomElement.addEventListener('touchmove', onCanvasTouchMove, { passive: false })
  controlsDomElement.addEventListener('touchend', onCanvasTouchEnd, { passive: true })
  controlsDomElement.addEventListener('touchcancel', onCanvasTouchEnd, { passive: true })
  if (props.headlessCapture) controls.enabled = false
}

function isMobileLayout(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < MOBILE_VIEWPORT_MAX_WIDTH_PX
}

function currentFitMultiplier(): number {
  return isMobileLayout() ? FIT_MULTIPLIER_MOBILE : FIT_MULTIPLIER
}

function currentMaxZoomRatio(): number {
  return isMobileLayout() ? DESIGNER_WHEEL_ZOOM_MAX_DISTANCE_RATIO_MOBILE : DESIGNER_WHEEL_ZOOM_MAX_DISTANCE_RATIO
}

function currentMinZoomRatio(): number {
  return isMobileLayout() ? DESIGNER_WHEEL_ZOOM_MIN_DISTANCE_RATIO_MOBILE : 1
}

function onCanvasWheel(ev: WheelEvent) {
  const maxRatio = currentMaxZoomRatio()
  const minRatio = currentMinZoomRatio()
  if (!controls || maxRatio <= minRatio) return
  ev.preventDefault()
  const delta = Math.max(-140, Math.min(140, ev.deltaY))
  wheelZoomDistanceRatio *= Math.exp(delta * DESIGNER_WHEEL_ZOOM_SENSITIVITY)
  wheelZoomDistanceRatio = Math.min(maxRatio, Math.max(minRatio, wheelZoomDistanceRatio))
  autoFitCamera()
  debouncedEmitCameraChange()
}

let pinchInitialDistance = 0
let pinchInitialZoomRatio = 1

function getTouchDistance(touches: TouchList): number {
  if (touches.length < 2) return 0
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.hypot(dx, dy)
}

function onCanvasTouchStart(ev: TouchEvent) {
  if (!controls || ev.touches.length !== 2) return
  pinchInitialDistance = getTouchDistance(ev.touches)
  pinchInitialZoomRatio = wheelZoomDistanceRatio
}

function onCanvasTouchMove(ev: TouchEvent) {
  const maxRatio = currentMaxZoomRatio()
  const minRatio = currentMinZoomRatio()
  if (!controls || maxRatio <= minRatio || ev.touches.length !== 2 || pinchInitialDistance <= 0) return
  ev.preventDefault()
  const newDistance = getTouchDistance(ev.touches)
  if (newDistance <= 0) return
  const scale = newDistance / pinchInitialDistance
  const next = pinchInitialZoomRatio / scale
  wheelZoomDistanceRatio = Math.min(maxRatio, Math.max(minRatio, next))
  autoFitCamera()
  debouncedEmitCameraChange()
}

function onCanvasTouchEnd(ev: TouchEvent) {
  if (ev.touches.length < 2) pinchInitialDistance = 0
}

function autoFitCamera() {
  const bbox = new THREE.Box3().setFromObject(panelGroup)
  const sphere = new THREE.Sphere()
  if (tracked.size === 0 || bbox.isEmpty()) {
    sphere.center.set(0, Math.max(0.1, lastFitCenterY), 0)
    sphere.radius = 0.35
  }
  else {
    bbox.getBoundingSphere(sphere)
    if (!isFinite(sphere.radius) || sphere.radius < 1e-4) sphere.radius = 0.35
  }
  lastFitCenterY = sphere.center.y

  const vfov = (camera.fov * Math.PI) / 180
  const hfov = 2 * Math.atan(Math.tan(vfov * 0.5) * camera.aspect)
  const dV = sphere.radius / Math.sin(Math.max(1e-4, vfov * 0.5))
  const dH = sphere.radius / Math.sin(Math.max(1e-4, hfov * 0.5))
  const dist = Math.max(dV, dH, 0.001) * currentFitMultiplier()
  const baseDist = Math.max(dist, DESIGNER_ORBIT_MIN_DISTANCE_M)
  const finalDist = baseDist * Math.min(currentMaxZoomRatio(), Math.max(currentMinZoomRatio(), wheelZoomDistanceRatio))

  const targetForDir = controls ? controls.target : sphere.center
  const dir = new THREE.Vector3().subVectors(camera.position, targetForDir).normalize()
  if (!Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z) || dir.lengthSq() < 1e-10) dir.set(1, 0.55, 1).normalize()
  if (controls) controls.target.copy(sphere.center)
  camera.position.copy(sphere.center).addScaledVector(dir, finalDist)
  if (controls) {
    controls.minDistance = finalDist
    controls.maxDistance = finalDist
    suppressCameraChange = true
    try {
      controls.update()
    }
    finally {
      suppressCameraChange = false
    }
  }
}

// ---------------------------------------------------------------------------
// Capture mode
// ---------------------------------------------------------------------------

const captureLocked = ref(false)
const captureWorldOffset = new THREE.Vector3()
const captureAxis = new THREE.Vector3(0, 1, 0)

function applyCaptureYaw() {
  if (!props.headlessCapture || !captureLocked.value || !controls) return
  const yaw = props.captureYawRadians ?? 0
  const target = controls.target
  const offset = captureWorldOffset.clone().applyAxisAngle(captureAxis, yaw)
  camera.position.copy(target).add(offset)
  camera.lookAt(target)
  controls.update()
}

watch(() => props.captureYawRadians, () => applyCaptureYaw())

watch(() => props.headlessCapture, (v) => {
  captureLocked.value = false
  if (controls) controls.enabled = !v
  if (v) destroyViewHelper()
  else nextTick(ensureViewHelper)
})

// ---------------------------------------------------------------------------
// Render-mode lighting + post-FX
// ---------------------------------------------------------------------------

const technicalRenderSize = new THREE.Vector2()
let technicalFillTarget: THREE.WebGLRenderTarget | null = null
let technicalSurfaceIdTarget: THREE.WebGLRenderTarget | null = null
let technicalOutlineExcludeTarget: THREE.WebGLRenderTarget | null = null

const technicalSurfaceIdMaterial = new THREE.MeshBasicMaterial({
  vertexColors: true,
  depthTest: true,
  depthWrite: true,
  toneMapped: false,
})
const technicalOutlineExcludeMaterial = new THREE.ShaderMaterial({
  depthTest: true,
  depthWrite: true,
  toneMapped: false,
  vertexShader: `
    attribute float outlineExclude;
    varying float vOutlineExclude;

    void main() {
      vOutlineExclude = outlineExclude;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision highp float;
    varying float vOutlineExclude;

    void main() {
      gl_FragColor = vec4(vOutlineExclude, 0.0, 0.0, 1.0);
    }
  `,
})

const technicalCompositeScene = new THREE.Scene()
const technicalCompositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
technicalCompositeCamera.position.z = 1
const technicalCompositeMaterial = new THREE.ShaderMaterial({
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
  uniforms: {
    tFill: { value: null as THREE.Texture | null },
    tSurfaceId: { value: null as THREE.Texture | null },
    tOutlineExclude: { value: null as THREE.Texture | null },
    invTexelSize: { value: new THREE.Vector2(1, 1) },
    inkRgb: { value: new THREE.Color(0xf59e0b) },
    inkStrength: { value: 1 },
    idThreshold: { value: 0.001 },
  },
  vertexShader: `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    precision highp float;

    uniform sampler2D tFill;
    uniform sampler2D tSurfaceId;
    uniform sampler2D tOutlineExclude;
    uniform vec2 invTexelSize;
    uniform vec3 inkRgb;
    uniform float inkStrength;
    uniform float idThreshold;

    varying vec2 vUv;

    vec3 linearToSrgb(vec3 c) {
      vec3 low = c * 12.92;
      vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
      return mix(low, high, step(vec3(0.0031308), c));
    }

    float excludeWeight(vec2 offset, float centerExclude) {
      float tapExclude = texture2D(tOutlineExclude, vUv + offset * invTexelSize).r;
      return (1.0 - centerExclude) * (1.0 - tapExclude);
    }

    float surfaceDelta(vec2 offset, vec3 centerId, float centerExclude) {
      vec3 sampleId = texture2D(tSurfaceId, vUv + offset * invTexelSize).rgb;
      return length(centerId - sampleId) * excludeWeight(offset, centerExclude);
    }

    void main() {
      vec3 fillRgb = linearToSrgb(texture2D(tFill, vUv).rgb);
      vec3 centerId = texture2D(tSurfaceId, vUv).rgb;
      float centerExclude = texture2D(tOutlineExclude, vUv).r;

      float edge = 0.0;
      edge += surfaceDelta(vec2( 1.0,  0.0), centerId, centerExclude);
      edge += surfaceDelta(vec2(-1.0,  0.0), centerId, centerExclude);
      edge += surfaceDelta(vec2( 0.0,  1.0), centerId, centerExclude);
      edge += surfaceDelta(vec2( 0.0, -1.0), centerId, centerExclude);
      edge += surfaceDelta(vec2( 1.0,  1.0), centerId, centerExclude);
      edge += surfaceDelta(vec2(-1.0,  1.0), centerId, centerExclude);
      edge += surfaceDelta(vec2( 1.0, -1.0), centerId, centerExclude);
      edge += surfaceDelta(vec2(-1.0, -1.0), centerId, centerExclude);

      float outlineMask = step(idThreshold, edge) * inkStrength;
      gl_FragColor = vec4(mix(fillRgb, inkRgb, outlineMask), 1.0);
    }
  `,
})
const technicalCompositeMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), technicalCompositeMaterial)
technicalCompositeScene.add(technicalCompositeMesh)
const technicalPreviousClearColor = new THREE.Color()

function setRawSrgbColor(color: THREE.Color, hex: number) {
  color.r = ((hex >> 16) & 0xff) / 255
  color.g = ((hex >> 8) & 0xff) / 255
  color.b = (hex & 0xff) / 255
}

function applyRenderModeLighting() {
  if (props.renderMode === 'render-debug') {
    ambient.intensity = 0.5
    keyLight.intensity = 2
    keyLight.castShadow = true
    if (!hemisphereGroup.parent) scene.add(hemisphereGroup)
    skydome.visible = false
  }
  else {
    ambient.intensity = 0.4
    keyLight.intensity = 1.15
    keyLight.castShadow = false
    if (hemisphereGroup.parent) scene.remove(hemisphereGroup)
    floorCatcher.visible = false
    skydome.visible = false
  }
  tickSceneGroundOpacity(0)
}

function makeTechnicalRenderTarget(width: number, height: number, nearest = false) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
  })
  target.texture.generateMipmaps = false
  if (nearest) {
    target.texture.magFilter = THREE.NearestFilter
    target.texture.minFilter = THREE.NearestFilter
  }
  return target
}

function disposeTechnicalRenderTargets() {
  technicalFillTarget?.dispose()
  technicalSurfaceIdTarget?.dispose()
  technicalOutlineExcludeTarget?.dispose()
  technicalFillTarget = null
  technicalSurfaceIdTarget = null
  technicalOutlineExcludeTarget = null
  technicalCompositeMaterial.uniforms.tFill.value = null
  technicalCompositeMaterial.uniforms.tSurfaceId.value = null
  technicalCompositeMaterial.uniforms.tOutlineExclude.value = null
}

function ensureTechnicalRenderTargets(width: number, height: number) {
  if (
    technicalFillTarget
    && technicalSurfaceIdTarget
    && technicalOutlineExcludeTarget
    && technicalFillTarget.width === width
    && technicalFillTarget.height === height
    && technicalSurfaceIdTarget.width === width
    && technicalSurfaceIdTarget.height === height
    && technicalOutlineExcludeTarget.width === width
    && technicalOutlineExcludeTarget.height === height
  ) {
    return
  }

  disposeTechnicalRenderTargets()
  technicalFillTarget = makeTechnicalRenderTarget(width, height)
  technicalSurfaceIdTarget = makeTechnicalRenderTarget(width, height, true)
  technicalOutlineExcludeTarget = makeTechnicalRenderTarget(width, height, true)
  technicalCompositeMaterial.uniforms.tFill.value = technicalFillTarget.texture
  technicalCompositeMaterial.uniforms.tSurfaceId.value = technicalSurfaceIdTarget.texture
  technicalCompositeMaterial.uniforms.tOutlineExclude.value = technicalOutlineExcludeTarget.texture
  technicalCompositeMaterial.uniforms.invTexelSize.value.set(1 / width, 1 / height)
}

function syncTechnicalPostprocessing() {
  if (props.renderMode !== 'technical') {
    disposeTechnicalRenderTargets()
    return
  }
  setRawSrgbColor(
    technicalCompositeMaterial.uniforms.inkRgb.value,
    hexFromString(resolvedPublicStyle.value.technical.colors.outlines, 0xf59e0b),
  )
}

function setTechnicalOperationOverlaysVisible(visible: boolean) {
  const changed: Array<{ object: THREE.Object3D, visible: boolean }> = []
  scene.traverse((object) => {
    if (!object.userData.technicalOperationOverlay) return
    changed.push({ object, visible: object.visible })
    object.visible = visible
  })
  return changed
}

function restoreObjectVisibility(changed: Array<{ object: THREE.Object3D, visible: boolean }>) {
  for (const item of changed) item.object.visible = item.visible
}

function renderTechnicalComposite(renderer: THREE.WebGLRenderer) {
  renderer.getDrawingBufferSize(technicalRenderSize)
  const width = Math.max(1, Math.floor(technicalRenderSize.x))
  const height = Math.max(1, Math.floor(technicalRenderSize.y))
  ensureTechnicalRenderTargets(width, height)

  if (!technicalFillTarget || !technicalSurfaceIdTarget || !technicalOutlineExcludeTarget) {
    renderer.render(scene, camera)
    return
  }

  renderer.setRenderTarget(technicalFillTarget)
  renderer.clear(true, true, true)
  renderer.render(scene, camera)

  renderer.getClearColor(technicalPreviousClearColor)
  const previousClearAlpha = renderer.getClearAlpha()
  const previousOverrideMaterial = scene.overrideMaterial
  const previousFloorVisible = floorCatcher.visible
  const previousSkydomeVisible = skydome.visible
  const overlayVisibility = setTechnicalOperationOverlaysVisible(false)

  try {
    floorCatcher.visible = false
    skydome.visible = false
    scene.overrideMaterial = technicalSurfaceIdMaterial
    renderer.setClearColor(0x000000, 1)
    renderer.setRenderTarget(technicalSurfaceIdTarget)
    renderer.clear(true, true, true)
    renderer.render(scene, camera)

    scene.overrideMaterial = technicalOutlineExcludeMaterial
    renderer.setRenderTarget(technicalOutlineExcludeTarget)
    renderer.clear(true, true, true)
    renderer.render(scene, camera)
  }
  finally {
    scene.overrideMaterial = previousOverrideMaterial
    floorCatcher.visible = previousFloorVisible
    skydome.visible = previousSkydomeVisible
    restoreObjectVisibility(overlayVisibility)
    renderer.setClearColor(technicalPreviousClearColor, previousClearAlpha)
  }

  renderer.setRenderTarget(null)
  renderer.render(technicalCompositeScene, technicalCompositeCamera)
}

function applyClearColor(renderer: THREE.WebGLRenderer) {
  const bg = props.renderMode === 'technical'
    ? hexFromString(resolvedPublicStyle.value.technical.colors.background, 0x1c1917)
    : props.renderMode === 'render-debug'
      ? hexFromString(resolvedPublicStyle.value.rendered.colors.background, 0x4d4a49)
      : getThemeColor('backgroundDefault').hex
  renderer.setClearColor(bg, 1)
}

// ---------------------------------------------------------------------------
// Restore initial camera state
// ---------------------------------------------------------------------------

function validCameraState(cs: CameraState | null | undefined): cs is CameraState {
  if (!cs) return false
  const values = [...cs.position, ...cs.quaternion, ...cs.target]
  return values.every(value => typeof value === 'number' && Number.isFinite(value))
    && cs.quaternion.reduce((sum, value) => sum + value * value, 0) > 1e-10
}

function restoreCameraState(cs: CameraState | null) {
  const next = validCameraState(cs) ? cs : DEFAULT_CAMERA_STATE
  camera.position.set(next.position[0], next.position[1], next.position[2])
  camera.quaternion.set(next.quaternion[0], next.quaternion[1], next.quaternion[2], next.quaternion[3])
  if (controls) {
    controls.target.set(next.target[0], next.target[1], next.target[2])
    lastFitCenterY = controls.target.y
    controls.update()
  }
}

// ---------------------------------------------------------------------------
// Wire up the render loop via the composable
// ---------------------------------------------------------------------------

const sceneRef = shallowRef(scene)
const cameraRef = shallowRef<THREE.Camera>(camera)
const gizmoScene = new THREE.Scene()
const gizmoCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 4)
const gizmoSceneRef = shallowRef(gizmoScene)
const gizmoCameraRef = shallowRef<THREE.Camera>(gizmoCamera)
let viewHelper: EditorViewHelper | null = null

function handleViewHelperPointerDown(event: PointerEvent) {
  if (!viewHelper?.handleClick(event)) return
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

function destroyViewHelper() {
  if (gizmoCanvasRef.value) {
    gizmoCanvasRef.value.removeEventListener('pointerdown', handleViewHelperPointerDown, true)
  }
  viewHelper?.dispose()
  viewHelper = null
}

function ensureViewHelper() {
  if (viewHelper || props.headlessCapture || !gizmoCanvasRef.value || !controls) return
  const c = colors.value
  viewHelper = new EditorViewHelper(camera, gizmoCanvasRef.value, {
    viewportPixels: GIZMO_SIZE_PX,
    contentScale: GIZMO_CONTENT_SCALE,
    axisColors: {
      x: c.neutral500.rgbCss,
      y: c.primary500.rgbCss,
      z: c.success500.rgbCss,
    },
  })
  const inset = Math.max(0, (GIZMO_SIZE_PX - GIZMO_SIZE_PX) / 2)
  viewHelper.location.left = inset
  viewHelper.location.top = inset
  viewHelper.location.right = 0
  viewHelper.location.bottom = 0
  viewHelper.center.copy(controls.target)
  gizmoCanvasRef.value.addEventListener('pointerdown', handleViewHelperPointerDown, true)
}

useThreejsCanvas({
  canvasRef,
  scene: sceneRef,
  camera: cameraRef,
  clearColor: 0x000000,
  clearAlpha: 0,
  onResize(w, h) {
    if (props.renderMode === 'technical') ensureTechnicalRenderTargets(w, h)
  },
  render(renderer, dt) {
    applyClearColor(renderer)
    renderer.shadowMap.enabled = props.renderMode === 'render-debug'
    tickAnimations(dt)
    tickSceneGroundOpacity(dt)
    if (!props.headlessCapture || !captureLocked.value) autoFitCamera()
    if (controls) {
      controls.update()
      keyLight.target.position.copy(controls.target)
      if (viewHelper) viewHelper.center.copy(controls.target)
    }
    if (viewHelper?.animating) viewHelper.update(dt)
    if (props.headlessCapture && captureLocked.value) {
      applyCaptureYaw()
    }
    if (props.renderMode === 'technical') renderTechnicalComposite(renderer)
    else renderer.render(scene, camera)
  },
})

useThreejsCanvas({
  canvasRef: gizmoCanvasRef,
  scene: gizmoSceneRef,
  camera: gizmoCameraRef,
  clearColor: getThemeColor('backgroundMuted').hex,
  clearAlpha: 1,
  render(renderer) {
    const bg = new THREE.Color()
    try {
      bg.setStyle(gizmoBackground.value)
    }
    catch {
      bg.setHex(getThemeColor('backgroundMuted').hex)
    }
    renderer.setClearColor(bg, 1)
    renderer.clear(true, true, true)
    ensureViewHelper()
    viewHelper?.render(renderer)
  },
})

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

/** A stable signature of every publicStyle field that affects panel materials,
 *  background, or grid. Changing any of these must trigger a scene rebuild so
 *  the Three.MeshStandardMaterial picks up the new color/roughness/metalness. */
const publicStyleSignature = computed(() => {
  const s = resolvedPublicStyle.value
  const m = s.rendered.materials
  const c = s.rendered.colors
  const t = s.technical.colors
  return [
    s.renderStyle,
    m.carcass.presetId, m.carcass.customColor,
    m.sides.presetId,   m.sides.customColor,
    m.deck.presetId,    m.deck.customColor,
    m.fronts.presetId,  m.fronts.customColor,
    c.background, c.grid, c.defaultPanel, c.verticalSide, c.horizontalDeck, c.moduleFront,
    t.background, t.grid, t.outlines, t.fills,
  ].join('|')
})

watch(
  () => ({
    doc: activeDoc.value,
    renderMode: props.renderMode,
    colorsGeneration: colors.value.generation,
    publicStyle: publicStyleSignature.value,
  }),
  (next, previous) => {
    buildScene({ preservePanelTransforms: Boolean(previous && next.doc === previous.doc) })
    applyRenderModeLighting()
    syncTechnicalPostprocessing()
    buildDotsGrid(hexFromString(gridColor.value, getThemeColor('neutral500').hex))
    tickSceneGroundOpacity(0)
  },
)

watch(
  () => [props.assemblyOpenDoorsDrawers, props.assemblySpaceModulesView],
  () => {
    recomputeTargets()
    tickSceneGroundOpacity(0)
  },
)

watch(() => colors.value.generation, () => {
  destroyViewHelper()
  nextTick(ensureViewHelper)
})

watch(() => props.initialCameraState, (cs) => {
  if (cameraStateKey(cs) === lastEmittedCameraStateKey) return
  restoreCameraState(cs)
})

// Live Y.Doc updates → rebuild
let docObserver: (() => void) | null = null
function attachDocObserver() {
  if (docObserver) {
    docObserver()
    docObserver = null
  }
  if (!activeDoc.value) return
  const handler = () => {
    buildScene({ preservePanelTransforms: true })
  }
  const doc = activeDoc.value
  doc.on('update', handler)
  docObserver = () => doc.off('update', handler)
}
watch(activeDoc, () => attachDocObserver(), { immediate: false })
watch(activeDoc, () => {
  wheelZoomDistanceRatio = 1
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
  nextTick(() => {
	    attachControls()
	    buildScene()
	    applyRenderModeLighting()
	    syncTechnicalPostprocessing()
	    buildDotsGrid(hexFromString(gridColor.value, getThemeColor('neutral500').hex))
	    tickSceneGroundOpacity(0)
	    restoreCameraState(props.initialCameraState)
    attachDocObserver()
    updateChromeTeleportTarget()
    ensureViewHelper()
  })
})

onBeforeUnmount(() => {
  if (cameraChangeTimer !== null) window.clearTimeout(cameraChangeTimer)
  destroyViewHelper()
  if (controls) {
    controlsDomElement?.removeEventListener('wheel', onCanvasWheel)
    controlsDomElement?.removeEventListener('touchstart', onCanvasTouchStart)
    controlsDomElement?.removeEventListener('touchmove', onCanvasTouchMove)
    controlsDomElement?.removeEventListener('touchend', onCanvasTouchEnd)
    controlsDomElement?.removeEventListener('touchcancel', onCanvasTouchEnd)
    controls.removeEventListener('change', onControlsChange)
    controls.removeEventListener('end', emitCameraChange)
    controls.dispose()
    controls = null
    controlsDomElement = null
  }
  clearTracked()
	  for (const c of dotsGroup.children) {
	    ;(c as THREE.Mesh).geometry?.dispose()
	    const material = (c as THREE.Mesh).material
	    if (material) disposeObjectMaterial(material)
	  }
  dotsGroup.clear()
  skydome.geometry.dispose()
  skydomeMat.dispose()
  floorCatcher.geometry.dispose()
  ;(floorCatcher.material as THREE.Material).dispose()
  disposeTechnicalRenderTargets()
  technicalSurfaceIdMaterial.dispose()
  technicalOutlineExcludeMaterial.dispose()
  technicalCompositeMaterial.dispose()
  technicalCompositeMesh.geometry.dispose()
  if (docObserver) docObserver()
  docObserver = null
})

// ---------------------------------------------------------------------------
// Imperative methods (capture pipeline)
// ---------------------------------------------------------------------------

function getCaptureCanvas(): HTMLCanvasElement | null {
  if (canvasRef.value) return canvasRef.value
  if (wrapperRef.value) return wrapperRef.value.querySelector('canvas')
  return null
}

function lockCaptureCamera() {
  autoFitCamera()
  if (controls) controls.update()
  if (controls) {
    captureWorldOffset.copy(camera.position).sub(controls.target)
  }
  captureLocked.value = true
  if (controls) controls.enabled = false
  applyCaptureYaw()
}

function waitForCapturePaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    const c = getCaptureCanvas() as (HTMLCanvasElement & { requestVideoFrameCallback?: (cb: () => void) => void }) | null
    if (c && typeof (c as any).requestVideoFrameCallback === 'function') {
      ;(c as any).requestVideoFrameCallback(() => requestAnimationFrame(() => resolve()))
    }
    else {
      fallback()
    }
  })
}

function getExportRoot(): THREE.Object3D | null {
  return panelGroup
}

defineExpose({ getCaptureCanvas, lockCaptureCamera, waitForCapturePaint, getExportRoot })

// ---------------------------------------------------------------------------
// Wrapper class — capture mode strips border per spec
// ---------------------------------------------------------------------------
const wrapperClass = computed(() =>
  props.headlessCapture
    ? 'relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-none bg-default'
    : 'relative flex h-full min-h-0 w-full cursor-grab touch-none select-none flex-col overflow-hidden rounded-lg bg-default shadow-sm ring-1 ring-default/60 active:cursor-grabbing',
)

const wrapperStyle = computed(() => ({
  backgroundColor: canvasBackgroundColor.value,
}))

const chromeTeleportTargetExists = ref(false)
const chromeTeleportSelector = computed(() => props.canvasChromeTeleportSelector?.trim() ?? '')
const chromeTeleportTarget = computed(() => chromeTeleportSelector.value || 'body')
const chromeTeleportDisabled = computed(() => !chromeTeleportSelector.value || !chromeTeleportTargetExists.value)
const chromeClass = computed(() => [
  'flex flex-row flex-wrap items-center justify-end gap-1.5',
  chromeTeleportDisabled.value
    ? 'pointer-events-auto absolute inset-x-3 top-16 z-20 md:inset-x-auto md:right-4 md:top-4'
    : 'pointer-events-auto',
])
const gizmoBackground = computed(() => colors.value.backgroundMuted.rgbCss)

const assemblyMode = computed<'normal' | 'open-doors' | 'space-modules'>(() => {
  if (props.assemblySpaceModulesView) return 'space-modules'
  if (props.assemblyOpenDoorsDrawers) return 'open-doors'
  return 'normal'
})

function setAssemblyMode(mode: 'normal' | 'open-doors' | 'space-modules') {
  emit('update:assemblyOpenDoorsDrawers', mode === 'open-doors')
  emit('update:assemblySpaceModulesView', mode === 'space-modules')
}

function updateChromeTeleportTarget() {
  if (typeof document === 'undefined' || !chromeTeleportSelector.value) {
    chromeTeleportTargetExists.value = false
    return
  }
  chromeTeleportTargetExists.value = Boolean(document.querySelector(chromeTeleportSelector.value))
}

watch(
  chromeTeleportSelector,
  () => {
    nextTick(() => {
      updateChromeTeleportTarget()
      requestAnimationFrame(updateChromeTeleportTarget)
    })
  },
  { immediate: true },
)
</script>

<template>
  <div
    ref="wrapperRef"
    :class="wrapperClass"
    :style="wrapperStyle"
  >
    <div
      ref="mainCanvasWrapperRef"
      class="relative min-h-0 w-full flex-1"
    >
      <canvas
        ref="canvasRef"
        class="block h-full w-full"
      />
    </div>
    <div
      v-if="!headlessCapture"
      class="canvas-gizmo-anchor pointer-events-auto absolute bottom-3 right-3 z-10 sm:bottom-4 sm:right-4"
    >
      <div
        ref="gizmoWrapperRef"
        class="shrink-0 overflow-hidden rounded-full shadow-md ring-1 ring-default/60"
        :style="{ width: `${GIZMO_SIZE_PX}px`, height: `${GIZMO_SIZE_PX}px`, backgroundColor: gizmoBackground }"
        @pointerdown.stop
        @wheel.stop
      >
        <canvas
          ref="gizmoCanvasRef"
          class="block h-full w-full cursor-grab transition-transform duration-150 active:scale-[0.97] active:cursor-grabbing"
        />
      </div>
    </div>
    <Teleport
      v-if="!headlessCapture"
      :to="chromeTeleportTarget"
      :disabled="chromeTeleportDisabled"
    >
      <div
        :class="chromeClass"
        @pointerdown.stop
        @wheel.stop
      >
        <div
          class="flex flex-row flex-wrap items-center gap-0.5 rounded-full bg-muted p-1 shadow-md ring-1 ring-default/60"
          role="group"
          aria-label="Assembly preview"
        >
          <UButton
            icon="i-lucide-package"
            size="sm"
            color="neutral"
            :variant="assemblyMode === 'normal' ? 'solid' : 'ghost'"
            aria-label="Normal assembly view"
            :aria-pressed="assemblyMode === 'normal'"
            class="size-8 justify-center rounded-full active:scale-[0.97] transition-transform duration-150"
            @click="setAssemblyMode('normal')"
          />
          <UButton
            icon="i-lucide-door-open"
            size="sm"
            color="neutral"
            :variant="assemblyMode === 'open-doors' ? 'solid' : 'ghost'"
            aria-label="Open doors and drawers preview"
            :aria-pressed="assemblyMode === 'open-doors'"
            class="size-8 justify-center rounded-full active:scale-[0.97] transition-transform duration-150"
            @click="setAssemblyMode('open-doors')"
          />
          <UButton
            icon="i-lucide-boxes"
            size="sm"
            color="neutral"
            :variant="assemblyMode === 'space-modules' ? 'solid' : 'ghost'"
            aria-label="Space modules view — pull panels apart"
            :aria-pressed="assemblyMode === 'space-modules'"
            class="size-8 justify-center rounded-full active:scale-[0.97] transition-transform duration-150"
            @click="setAssemblyMode('space-modules')"
          />
        </div>
        <div
          class="flex flex-wrap rounded-full bg-muted p-1 shadow-md ring-1 ring-default/60"
          role="group"
          aria-label="Canvas render mode"
        >
          <UButton
            icon="i-lucide-drafting-compass"
            size="sm"
            color="neutral"
            :variant="renderMode === 'technical' ? 'solid' : 'ghost'"
            aria-label="Technical drawing — outlines only"
            :aria-pressed="renderMode === 'technical'"
            class="size-8 justify-center rounded-full active:scale-[0.97] transition-transform duration-150"
            @click="emit('update:renderMode', 'technical')"
          />
          <UButton
            icon="i-lucide-palette"
            size="sm"
            color="neutral"
            :variant="renderMode === 'render-debug' ? 'solid' : 'ghost'"
            aria-label="Render debug — lit mesh with role colors"
            :aria-pressed="renderMode === 'render-debug'"
            class="size-8 justify-center rounded-full active:scale-[0.97] transition-transform duration-150"
            @click="emit('update:renderMode', 'render-debug')"
          />
        </div>
        <slot name="canvas-chrome-append" />
      </div>
    </Teleport>
  </div>
</template>
