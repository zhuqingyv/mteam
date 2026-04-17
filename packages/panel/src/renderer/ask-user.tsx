import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { LiquidBorder } from './lib/liquid-border'
import { TentacleRenderer } from './lib/tentacle-renderer'
import './ask-user.css'

// ── Types ───────────────────────────────────────────────────────────────────

type AskUserType = 'confirm' | 'single_choice' | 'multi_choice' | 'input'

interface AskUserRequest {
  id: string
  member_name: string
  type: AskUserType
  title: string
  question: string
  options?: string[]
  timeout_ms: number
  created_at: number
  member_color: [number, number, number]
  source_terminal?: { x: number; y: number; w: number; h: number }
}

interface Bridge {
  onShowRequest: (cb: (request: AskUserRequest) => void) => void
  getRequest: () => Promise<AskUserRequest | null>
  submitResponse: (requestId: string, response: { choice?: string | string[]; input?: string }) => void
  cancel: (requestId: string) => void
  getWindowBounds: () => Promise<{ x: number; y: number; w: number; h: number } | null>
}

const bridge = (window as unknown as { askUserBridge: Bridge }).askUserBridge

// ── Visual effects initialization ───────────────────────────────────────────

let liquidBorder: LiquidBorder | null = null
let tentacleRenderer: TentacleRenderer | null = null

function initLiquidBorder(color: [number, number, number]): void {
  const canvas = document.getElementById('border-canvas') as HTMLCanvasElement | null
  if (!canvas) return
  try {
    liquidBorder = new LiquidBorder(canvas, {
      colors: color,
      cornerRadius: 12,
      borderWidth: 3,
      wobbleIntensity: 0.8,
      animationSpeed: 0.7,
      glowEnabled: true,
      activityMode: true,
      margin: 12,
    })
    liquidBorder.setActivity(0.6)
    liquidBorder.start()
  } catch (e) {
    console.warn('[ask-user] LiquidBorder init failed:', e)
  }
}

async function initTentacle(
  color: [number, number, number],
  sourceTerminal: { x: number; y: number; w: number; h: number }
): Promise<void> {
  const canvas = document.getElementById('tentacle-canvas') as HTMLCanvasElement | null
  if (!canvas) return

  // Get current popup window bounds in screen coordinates
  const popupBounds = await bridge.getWindowBounds()
  if (!popupBounds) return

  try {
    tentacleRenderer = new TentacleRenderer(canvas)

    // Convert screen coordinates to window-local coordinates
    // The tentacle canvas covers the popup window, so we need relative positions
    // Source terminal is in screen coords, popup is in screen coords
    // We render in popup-local coords where (0,0) is popup top-left
    const fromBox = {
      x: sourceTerminal.x - popupBounds.x,
      y: sourceTerminal.y - popupBounds.y,
      w: sourceTerminal.w,
      h: sourceTerminal.h,
    }
    const toBox = {
      x: 0,
      y: 0,
      w: popupBounds.w,
      h: popupBounds.h,
    }

    tentacleRenderer.addTentacle({
      fromBox,
      toBox,
      colorA: color,
      colorB: color,
      reach: 1.2,
    })
    tentacleRenderer.start()
  } catch (e) {
    console.warn('[ask-user] TentacleRenderer init failed:', e)
  }
}

function disposeEffects(): void {
  if (liquidBorder) { liquidBorder.dispose(); liquidBorder = null }
  if (tentacleRenderer) { tentacleRenderer.dispose(); tentacleRenderer = null }
}

// ── App ─────────────────────────────────────────────────────────────────────

function AskUserApp() {
  const [request, setRequest] = useState<AskUserRequest | null>(null)
  const [remaining, setRemaining] = useState(120)
  const [selectedSingle, setSelectedSingle] = useState<string>('')
  const [selectedMulti, setSelectedMulti] = useState<Set<string>>(new Set())
  const [inputValue, setInputValue] = useState('')
  const [noteValue, setNoteValue] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const effectsInitRef = useRef(false)

  const initEffects = useCallback((req: AskUserRequest) => {
    if (effectsInitRef.current) return
    effectsInitRef.current = true

    // Initialize liquid border with member color
    initLiquidBorder(req.member_color)

    // Initialize tentacle to source terminal (if available)
    if (req.source_terminal) {
      initTentacle(req.member_color, req.source_terminal)
    }
  }, [])

  useEffect(() => {
    // Listen for push from main
    bridge.onShowRequest((req) => {
      setRequest(req)
      setRemaining(Math.ceil(req.timeout_ms / 1000))
      if (req.options?.length) {
        setSelectedSingle(req.options[0])
      }
      initEffects(req)
    })
    // Fallback: pull on load
    bridge.getRequest().then((req) => {
      if (req) {
        setRequest(req)
        setRemaining(Math.ceil(req.timeout_ms / 1000))
        if (req.options?.length) {
          setSelectedSingle(req.options[0])
        }
        initEffects(req)
      }
    })

    return () => disposeEffects()
  }, [initEffects])

  // Update liquid border activity based on timer urgency
  useEffect(() => {
    if (!liquidBorder || remaining <= 0) return
    const totalSecs = request?.timeout_ms ? request.timeout_ms / 1000 : 120
    const fraction = remaining / totalSecs
    // Activity increases as time runs out: 0.4 at start -> 1.0 at end
    const activity = 0.4 + (1 - fraction) * 0.6
    liquidBorder.setActivity(activity)
  }, [remaining, request])

  useEffect(() => {
    if (!request) return
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current)
          // Window will close via timeout handled by main process; just show 0
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [request])

  // Visual progress: fraction of time remaining (1.0 = full, 0.0 = empty)
  const totalSecs = request ? request.timeout_ms / 1000 : 120
  const progressFraction = request ? Math.max(0, remaining / totalSecs) : 1

  const handleSubmit = useCallback(() => {
    if (!request) return
    const response: { choice?: string | string[]; input?: string } = {}

    switch (request.type) {
      case 'confirm':
        response.choice = 'confirmed'
        break
      case 'single_choice':
        response.choice = selectedSingle
        break
      case 'multi_choice':
        response.choice = Array.from(selectedMulti)
        break
      case 'input':
        response.input = inputValue
        break
    }

    if (noteValue.trim()) {
      response.input = response.input
        ? `${response.input}\n---\n${noteValue.trim()}`
        : noteValue.trim()
    }

    bridge.submitResponse(request.id, response)
  }, [request, selectedSingle, selectedMulti, inputValue, noteValue])

  const handleReject = useCallback(() => {
    if (!request) return
    if (request.type === 'confirm') {
      bridge.submitResponse(request.id, { choice: 'rejected', input: noteValue.trim() || undefined })
    } else {
      bridge.cancel(request.id)
    }
  }, [request, noteValue])

  if (!request) {
    return (
      <div className="ask-user-container">
        <div className="ask-user-card">
          <p className="ask-user-loading">Loading...</p>
        </div>
      </div>
    )
  }

  const timerColor = remaining <= 10 ? '#ef4444' : remaining <= 30 ? '#f59e0b' : '#6b7280'
  const progressColor = remaining <= 10 ? '#ef4444' : remaining <= 30 ? '#f59e0b' : `rgb(${request.member_color[0]}, ${request.member_color[1]}, ${request.member_color[2]})`

  // Tint the member badge with the member's actual color
  const [r, g, b] = request.member_color
  const badgeStyle = {
    color: `rgb(${r}, ${g}, ${b})`,
    background: `rgba(${r}, ${g}, ${b}, 0.15)`,
  }

  return (
    <div className="ask-user-container">
      <div className="ask-user-card">
        {/* Header */}
        <div className="ask-user-header">
          <div className="ask-user-header-left">
            <span className="ask-user-member-badge" style={badgeStyle}>{request.member_name}</span>
            <span className="ask-user-title">{request.title}</span>
          </div>
          <span className="ask-user-timer" style={{ color: timerColor }}>{remaining}s</span>
        </div>

        {/* Countdown progress bar */}
        <div style={{ width: '100%', height: '3px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden', marginBottom: '4px' }}>
          <div style={{
            height: '100%',
            width: `${progressFraction * 100}%`,
            background: progressColor,
            borderRadius: '2px',
            transition: 'width 1s linear, background 0.5s ease',
          }} />
        </div>

        {/* Question */}
        <div className="ask-user-body">
          <p className="ask-user-question">{request.question}</p>

          {/* Type-specific content */}
          {request.type === 'single_choice' && request.options && (
            <div className="ask-user-options">
              {request.options.map((opt) => (
                <label key={opt} className="ask-user-option-label">
                  <input
                    type="radio"
                    name="single_choice"
                    value={opt}
                    checked={selectedSingle === opt}
                    onChange={() => setSelectedSingle(opt)}
                    className="ask-user-radio"
                  />
                  <span className="ask-user-option-text">{opt}</span>
                </label>
              ))}
            </div>
          )}

          {request.type === 'multi_choice' && request.options && (
            <div className="ask-user-options">
              {request.options.map((opt) => (
                <label key={opt} className="ask-user-option-label">
                  <input
                    type="checkbox"
                    checked={selectedMulti.has(opt)}
                    onChange={() => {
                      setSelectedMulti((prev) => {
                        const next = new Set(prev)
                        if (next.has(opt)) next.delete(opt)
                        else next.add(opt)
                        return next
                      })
                    }}
                    className="ask-user-checkbox"
                  />
                  <span className="ask-user-option-text">{opt}</span>
                </label>
              ))}
            </div>
          )}

          {request.type === 'input' && (
            <textarea
              className="ask-user-textarea"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Enter your response..."
              autoFocus
            />
          )}

          {/* Optional note field (for confirm/choice types) */}
          {request.type !== 'input' && (
            <input
              type="text"
              className="ask-user-note-input"
              value={noteValue}
              onChange={(e) => setNoteValue(e.target.value)}
              placeholder="Optional note..."
            />
          )}
        </div>

        {/* Actions */}
        <div className="ask-user-actions">
          <button className="ask-user-btn-reject" onClick={handleReject}>
            {request.type === 'confirm' ? 'Reject' : 'Cancel'}
          </button>
          <button className="ask-user-btn-confirm" onClick={handleSubmit}>
            {request.type === 'confirm' ? 'Confirm' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Mount ───────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById('root')!)
root.render(<AskUserApp />)
