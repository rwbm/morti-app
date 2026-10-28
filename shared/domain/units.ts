/** El modelo usa metros; el despiece se presenta siempre en milímetros. */
const millimetreFormatter = new Intl.NumberFormat('es-UY', {
  useGrouping: false,
  maximumFractionDigits: 3,
})

export function formatMillimetres(metres: number | null | undefined): string {
  if (metres == null || !Number.isFinite(metres)) return '—'
  return millimetreFormatter.format(metres * 1000)
}
