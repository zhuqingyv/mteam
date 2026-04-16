import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
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
}

interface Bridge {
  onShowRequest: (cb: (request: AskUserRequest) => void) => void
  getRequest: () => Promise<AskUserRequest | null>
  submitResponse: (requestId: string, response: { choice?: string | string[]; input?: string }) => void
  cancel: (requestId: string) => void
}

const bridge = (window as unknown as { askUserBridge: Bridge }).askUserBridge

// ── App ─────────────────────────────────────────────────────────────────────

function AskUserApp() {
  const [request, setRequest] = useState<AskUserRequest | null>(null)
  const [remaining, setRemaining] = useState(120)
  const [selectedSingle, setSelectedSingle] = useState<string>('')
  const [selectedMulti, setSelectedMulti] = useState<Set<string>>(new Set())
  const [inputValue, setInputValue] = useState('')
  const [noteValue, setNoteValue] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // Listen for push from main
    bridge.onShowRequest((req) => {
      setRequest(req)
      setRemaining(Math.ceil(req.timeout_ms / 1000))
      if (req.options?.length) {
        setSelectedSingle(req.options[0])
      }
    })
    // Fallback: pull on load
    bridge.getRequest().then((req) => {
      if (req) {
        setRequest(req)
        setRemaining(Math.ceil(req.timeout_ms / 1000))
        if (req.options?.length) {
          setSelectedSingle(req.options[0])
        }
      }
    })
  }, [])

  useEffect(() => {
    if (!request) return
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [request])

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

  return (
    <div className="ask-user-container">
      <div className="ask-user-card">
        {/* Header */}
        <div className="ask-user-header">
          <div className="ask-user-header-left">
            <span className="ask-user-member-badge">{request.member_name}</span>
            <span className="ask-user-title">{request.title}</span>
          </div>
          <span className="ask-user-timer" style={{ color: timerColor }}>{remaining}s</span>
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
