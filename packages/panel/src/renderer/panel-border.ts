// ── WebGL2 Liquid SDF Border for Panel Window ─────────────────────────────────
// Multi-member color gradient flowing around the border like a marquee.
// Uses LiquidBorder reusable module with gradient color mode

import { LiquidBorder } from './lib/liquid-border'

// ── Color palette (same as terminal-window.ts / Avatar.tsx) ──────────────────
const PALETTE_HEX = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#2563eb',
]
const PALETTE_RGB: number[][] = PALETTE_HEX.map(hex => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
])

function uidToColorRgb(uid: string): number[] {
  let hash = 0
  for (let i = 0; i < uid.length; i++) {
    hash = ((hash << 5) - hash + uid.charCodeAt(i)) | 0
  }
  return PALETTE_RGB[Math.abs(hash) % PALETTE_RGB.length] as [number, number, number]
}

// ── Member colors ────────────────────────────────────────────────────────────
const MAX_COLORS = 16
// Default: single accent color
let memberColors: [number, number, number][] = [[99, 102, 241]] // indigo-500

const canvas = document.getElementById('border-canvas') as HTMLCanvasElement
if (!canvas) throw new Error('border-canvas not found')

const border = new LiquidBorder(canvas, {
  colors: memberColors,
  cornerRadius: 12,
  borderWidth: 4,
  idleFPS: 24,
  activeFPS: 24,
  glowEnabled: false,
  activityMode: false,
})

async function loadMemberColors(): Promise<void> {
  try {
    const status = await (window as any).teamHub.getInitialStatus()
    updateColorsFromStatus(status)
  } catch { /* use default */ }
}

function updateColorsFromStatus(status: any): void {
  if (!status?.members?.length) return
  const colors: [number, number, number][] = []
  for (const m of status.members) {
    if (m.uid && colors.length < MAX_COLORS) {
      const rgb = uidToColorRgb(m.uid)
      colors.push([rgb[0], rgb[1], rgb[2]])
    }
  }
  if (colors.length > 0) {
    memberColors = colors
    border.setColors(colors)
  }
}

// Listen for status updates
if ((window as any).teamHub?.onStatusUpdate) {
  (window as any).teamHub.onStatusUpdate(updateColorsFromStatus)
}

// Start rendering
loadMemberColors().then(() => {
  border.start()
})

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  border.dispose()
})

export {}
