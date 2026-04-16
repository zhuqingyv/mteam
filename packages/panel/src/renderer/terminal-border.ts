// ── WebGL2 Liquid SDF Border for Terminal Windows ────────────────────────────
// Uses LiquidBorder reusable module

import { LiquidBorder } from './lib/liquid-border'

declare global {
  interface Window {
    terminalBridge: {
      onPtyOutput: (cb: (data: string) => void) => void
      sendInput: (data: string) => void
      notifyReady: (cols: number, rows: number) => void
      notifyResize: (cols: number, rows: number) => void
      getMemberColor: () => Promise<number[]>
      getMemberName: () => Promise<string>
      closeWindow: () => void
    }
  }
}

const canvas = document.getElementById('border-canvas') as HTMLCanvasElement
if (!canvas) throw new Error('border-canvas not found')

let memberColor: [number, number, number] = [100, 180, 255]

async function loadColor(): Promise<void> {
  if (window.terminalBridge?.getMemberColor) {
    try {
      const color = await window.terminalBridge.getMemberColor()
      if (Array.isArray(color) && color.length === 3) {
        memberColor = color as [number, number, number]
        return
      }
    } catch { /* fall through */ }
  }
  const params = new URLSearchParams(window.location.search)
  const colorParam = params.get('color')
  if (colorParam) {
    const parts = colorParam.split(',').map(Number)
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      memberColor = parts as [number, number, number]
    }
  }
}

const border = new LiquidBorder(canvas, {
  colors: memberColor,
  cornerRadius: 8,
  borderWidth: 4,
  idleFPS: 24,
  activeFPS: 60,
  glowEnabled: true,
  activityMode: true,
})

loadColor().then(() => {
  border.setColor(memberColor)
  border.start()
})

// Update activity from window property
const updateActivity = () => {
  const activity: number = (window as any).__borderActivity || 0
  border.setActivity(activity)
}

const interval = setInterval(updateActivity, 50)
updateActivity()

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  clearInterval(interval)
  border.dispose()
})

export {}
