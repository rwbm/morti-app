<script setup lang="ts">
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import { compilePartGeometry } from '~~/shared/domain/assembly'
import { useThemeColors } from '~~/composables/useThemeColors'
import { useThreejsCanvas } from '~~/composables/useThreejsCanvas'
import {
  addOutlineExcludeAttribute,
  bakeSurfaceIdsForGeometry,
  SurfaceIdPalette,
} from '~~/shared/three/outline'
import { makePanelMaterial } from '~~/shared/three/materials'
import type { CompiledPanel, PanelOperation } from '~~/shared/domain/types'
import { panelRoleLabel } from '~~/shared/domain/cutlist'

interface Props {
  part: CompiledPanel
  operations: PanelOperation[]
}

const props = defineProps<Props>()

const wrapperRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const { colors } = useThemeColors()

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(28, 1, 0.001, 100)
const partGroup = new THREE.Group()
scene.add(partGroup)

let panelMesh: THREE.Mesh | null = null
let panelGeometry: THREE.BufferGeometry | null = null
let panelMaterial: THREE.Material | null = null
let panelEdgeLines: THREE.LineSegments | null = null
let panelEdgeGeometry: THREE.EdgesGeometry | null = null
let panelEdgeMaterial: THREE.LineBasicMaterial | null = null
const cutOverlays: THREE.LineSegments[] = []
const palette = new SurfaceIdPalette()

const camDir = new THREE.Vector3(0.85, 0.65, 1.4).normalize()
const focusTarget = new THREE.Vector3()

let controls: OrbitControls | null = null
let requestCanvasRender: (() => void) | null = null

function handleControlsChange() {
  requestCanvasRender?.()
}

function disposePanelMesh() {
  if (panelMesh) {
    partGroup.remove(panelMesh)
    panelMesh = null
  }
  if (panelGeometry) {
    panelGeometry.dispose()
    panelGeometry = null
  }
  if (panelMaterial) {
    panelMaterial.dispose()
    panelMaterial = null
  }
  if (panelEdgeLines) {
    partGroup.remove(panelEdgeLines)
    panelEdgeLines = null
  }
  if (panelEdgeGeometry) {
    panelEdgeGeometry.dispose()
    panelEdgeGeometry = null
  }
  if (panelEdgeMaterial) {
    panelEdgeMaterial.dispose()
    panelEdgeMaterial = null
  }
}

function clearOverlays() {
  for (const o of cutOverlays) {
    partGroup.remove(o)
    o.geometry.dispose()
    ;(o.material as THREE.Material).dispose()
  }
  cutOverlays.length = 0
}

function rebuildPanel() {
  disposePanelMesh()
  palette.reset()
  panelGeometry = compilePartGeometry(props.part, props.operations)
  bakeSurfaceIdsForGeometry(panelGeometry, { palette, label: props.part.key })
  addOutlineExcludeAttribute(panelGeometry, 0)
  panelMaterial = makePanelMaterial('outline', colors.value.backgroundDefault.hex)
  panelMesh = new THREE.Mesh(panelGeometry, panelMaterial)
  panelMesh.name = props.part.key
  partGroup.add(panelMesh)

  panelEdgeGeometry = new THREE.EdgesGeometry(panelGeometry, 1)
  panelEdgeMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color(colors.value.uiPrimary.hex),
    depthTest: true,
    depthWrite: true,
  })
  panelEdgeMaterial.toneMapped = false
  panelEdgeLines = new THREE.LineSegments(panelEdgeGeometry, panelEdgeMaterial)
  panelEdgeLines.name = `${props.part.key}:edges`
  partGroup.add(panelEdgeLines)
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
  return geometry
}

function rebuildOverlays() {
  clearOverlays()
  const half = Math.max(0.001, props.part.thickness) / 2
  const fillColor = colors.value.textDefault.hex
  for (const op of props.operations) {
    if (op.operationType !== 'rail-cut') continue
    if (op.targetPanelKey !== props.part.key) continue
    const length = op.length ?? op.width ?? 0
    const width = op.length !== undefined ? (op.width ?? 0) : (op.height ?? 0)
    if (length <= 0 || width <= 0) continue
    const geometry = makeRailCutOutlineGeometry(length, width)
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(fillColor),
      depthTest: true,
      depthWrite: true,
    })
    material.toneMapped = false
    const overlay = new THREE.LineSegments(geometry, material)
    const sign = op.face === 'back' ? -1 : 1
    overlay.position.set(
      op.center?.x ?? op.x ?? 0,
      op.center?.y ?? op.y ?? 0,
      sign * (half + 6e-4),
    )
    if (sign === -1) {
      overlay.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
    }
    if (op.rotation && Math.abs(op.rotation) > 1e-9) {
      overlay.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), op.rotation))
    }
    partGroup.add(overlay)
    cutOverlays.push(overlay)
  }
}

function frameCamera() {
  if (!panelMesh) return
  const bbox = new THREE.Box3().setFromObject(panelMesh)
  if (bbox.isEmpty()) return
  const sphere = new THREE.Sphere()
  bbox.getBoundingSphere(sphere)
  if (!isFinite(sphere.radius) || sphere.radius < 1e-4) sphere.radius = 0.35
  focusTarget.copy(sphere.center)
  const fov = (camera.fov * Math.PI) / 180
  const dist = Math.max(0.08, (sphere.radius / Math.sin(Math.max(1e-4, fov / 2))) * 1.25)
  camera.position.copy(focusTarget).addScaledVector(camDir, dist)
  camera.near = Math.max(0.001, dist / 100)
  camera.far = Math.max(10, dist * 100)
  camera.lookAt(focusTarget)
  camera.updateProjectionMatrix()
  if (controls) {
    controls.target.copy(focusTarget)
    controls.minDistance = Math.max(dist * 0.25, 0.05)
    controls.maxDistance = dist * 6
    controls.update()
  }
}

const sceneRef = shallowRef(scene)
const cameraRef = shallowRef<THREE.Camera>(camera)

const canvasHandle = useThreejsCanvas({
  canvasRef,
  scene: sceneRef,
  camera: cameraRef,
  clearColor: 0x000000,
  clearAlpha: 0,
  manual: true,
  onResize() {
    // OrbitControls / camera aspect updates handled by composable.
  },
  render(renderer) {
    controls?.update()
    renderer.setClearColor(new THREE.Color(colors.value.backgroundDefault.hex), 1)
    renderer.render(scene, camera)
  },
})

requestCanvasRender = canvasHandle.requestRender

function attachControls() {
  if (controls || !canvasRef.value) return
  controls = new OrbitControls(camera, canvasRef.value)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false
  controls.enableZoom = false
  controls.rotateSpeed = 0.9
  controls.target.copy(focusTarget)
  controls.addEventListener('change', handleControlsChange)
}

watch(
  () => [props.part, props.operations, colors.value.generation],
  () => {
    rebuildPanel()
    rebuildOverlays()
    frameCamera()
    nextTick(() => requestCanvasRender?.())
  },
  { deep: true },
)

onMounted(() => {
  rebuildPanel()
  rebuildOverlays()
  nextTick(() => {
    attachControls()
    frameCamera()
    requestCanvasRender?.()
  })
})

onBeforeUnmount(() => {
  if (controls) {
    controls.removeEventListener('change', handleControlsChange)
    controls.dispose()
    controls = null
  }
  clearOverlays()
  disposePanelMesh()
})

const ariaLabel = computed(() => `Vista de la pieza: ${panelRoleLabel(props.part.role)}`)
</script>

<template>
  <div
    ref="wrapperRef"
    class="relative h-full min-h-0 w-full cursor-grab touch-none select-none overflow-hidden rounded-md bg-default shadow-sm ring-1 ring-default/60 active:cursor-grabbing"
    :aria-label="ariaLabel"
  >
    <canvas ref="canvasRef" class="block h-full w-full" />
  </div>
</template>
