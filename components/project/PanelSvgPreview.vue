<script setup lang="ts">
import type { CompiledPanel, PanelOperation } from '~~/shared/domain/types'
import { panelRoleLabel } from '~~/shared/domain/cutlist'
import { useThemeColors } from '~~/composables/useThemeColors'

interface Props {
  part: CompiledPanel
  operations: PanelOperation[]
}

interface Vec3 {
  x: number
  y: number
  z: number
}

interface Segment {
  a: Vec3
  b: Vec3
  color: string
  width: number
}

interface SvgSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
}

const props = defineProps<Props>()
const { colors } = useThemeColors()

const cameraDir = normalize({ x: 0.85, y: 0.65, z: 1.4 })
const screenRight = normalize(cross({ x: 0, y: 1, z: 0 }, cameraDir))
const screenUp = normalize(cross(cameraDir, screenRight))

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function project(p: Vec3) {
  return {
    x: dot(p, screenRight),
    y: -dot(p, screenUp),
  }
}

function rotate2d(x: number, y: number, rotation: number) {
  if (!rotation) return { x, y }
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  return {
    x: x * c - y * s,
    y: x * s + y * c,
  }
}

function addSegment(segments: Segment[], a: Vec3, b: Vec3, color: string, width = 0.7) {
  segments.push({ a, b, color, width })
}

function addPolyline(segments: Segment[], points: Vec3[], color: string, width = 0.7, closed = true) {
  for (let i = 0; i < points.length - 1; i++) addSegment(segments, points[i]!, points[i + 1]!, color, width)
  if (closed && points.length > 2) addSegment(segments, points[points.length - 1]!, points[0]!, color, width)
}

function boxSegments(panel: CompiledPanel, color: string): Segment[] {
  const w = Math.max(0.001, panel.width)
  const h = Math.max(0.001, panel.height)
  const t = Math.max(0.001, panel.thickness)
  const x0 = -w / 2
  const x1 = w / 2
  const y0 = -h / 2
  const y1 = h / 2
  const z0 = -t / 2
  const z1 = t / 2
  const p = [
    { x: x0, y: y0, z: z0 },
    { x: x1, y: y0, z: z0 },
    { x: x1, y: y1, z: z0 },
    { x: x0, y: y1, z: z0 },
    { x: x0, y: y0, z: z1 },
    { x: x1, y: y0, z: z1 },
    { x: x1, y: y1, z: z1 },
    { x: x0, y: y1, z: z1 },
  ]
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ]
  const segments: Segment[] = []
  for (const [a, b] of edges) addSegment(segments, p[a]!, p[b]!, color)
  return segments
}

function operationSegments(panel: CompiledPanel, operations: PanelOperation[], color: string): Segment[] {
  const segments: Segment[] = []
  const half = Math.max(0.001, panel.thickness) / 2

  for (const op of operations) {
    if (op.targetPanelKey !== panel.key) continue
    const sign = op.face === 'back' ? -1 : 1
    const z = sign * (half + 0.0006)
    const cx = op.center?.x ?? op.cx ?? op.x ?? 0
    const cy = op.center?.y ?? op.cy ?? op.y ?? 0

    if (op.operationType === 'rail-cut') {
      const length = op.length ?? op.width ?? 0
      const width = op.length !== undefined ? (op.width ?? 0) : (op.height ?? 0)
      if (length <= 0 || width <= 0) continue
      const hx = length / 2
      const hy = width / 2
      const corners = [
        rotate2d(-hx, -hy, op.rotation ?? 0),
        rotate2d(hx, -hy, op.rotation ?? 0),
        rotate2d(hx, hy, op.rotation ?? 0),
        rotate2d(-hx, hy, op.rotation ?? 0),
      ].map(point => ({ x: cx + point.x, y: cy + point.y, z }))
      addPolyline(segments, corners, color, 0.55)
    }
    else if (op.operationType === 'through-hole') {
      const diameter = op.diameter ?? 0
      if (diameter <= 0) continue
      const radius = diameter / 2
      const points: Vec3[] = []
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2
        points.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, z })
      }
      addPolyline(segments, points, color, 0.55)
    }
  }

  return segments
}

const svgSegments = computed<SvgSegment[]>(() => {
  const primary = colors.value.uiPrimary.rgbCss
  const operationColor = colors.value.textDefault.rgbCss
  const raw = [
    ...boxSegments(props.part, primary),
    ...operationSegments(props.part, props.operations, operationColor),
  ]
  const projected = raw.map(segment => ({
    ...segment,
    pa: project(segment.a),
    pb: project(segment.b),
  }))
  const points = projected.flatMap(segment => [segment.pa, segment.pb])
  const minX = Math.min(...points.map(point => point.x))
  const maxX = Math.max(...points.map(point => point.x))
  const minY = Math.min(...points.map(point => point.y))
  const maxY = Math.max(...points.map(point => point.y))
  const width = Math.max(0.001, maxX - minX)
  const height = Math.max(0.001, maxY - minY)
  const padding = 12
  const scale = Math.min((100 - padding * 2) / width, (100 - padding * 2) / height)
  const offsetX = (100 - width * scale) / 2 - minX * scale
  const offsetY = (100 - height * scale) / 2 - minY * scale

  return projected.map(segment => ({
    x1: segment.pa.x * scale + offsetX,
    y1: segment.pa.y * scale + offsetY,
    x2: segment.pb.x * scale + offsetX,
    y2: segment.pb.y * scale + offsetY,
    color: segment.color,
    width: segment.width,
  }))
})

const ariaLabel = computed(() => `Vista de la pieza: ${panelRoleLabel(props.part.role)}`)
</script>

<template>
  <div
    class="relative h-full min-h-0 w-full overflow-hidden rounded-md bg-default shadow-sm ring-1 ring-default/60"
    :aria-label="ariaLabel"
  >
    <svg
      class="block h-full w-full tabular-nums"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      shape-rendering="geometricPrecision"
    >
      <line
        v-for="(segment, index) in svgSegments"
        :key="index"
        :x1="segment.x1"
        :y1="segment.y1"
        :x2="segment.x2"
        :y2="segment.y2"
        :stroke="segment.color"
        :stroke-width="segment.width"
        vector-effect="non-scaling-stroke"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </div>
</template>
