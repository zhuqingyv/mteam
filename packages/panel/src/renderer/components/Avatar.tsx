import React from 'react'
import styles from './Avatar.module.css'

// 基于 uid 生成固定颜色
const PALETTE = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#2563eb',
]

function uidToColor(uid: string): string {
  let hash = 0
  for (let i = 0; i < uid.length; i++) {
    hash = ((hash << 5) - hash + uid.charCodeAt(i)) | 0
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

function getInitial(displayName: string): string {
  return displayName.charAt(0)
}

interface Props {
  uid: string
  displayName: string
  size?: number
  status?: 'reserved' | 'working' | 'offline'
}

const dotClass: Record<string, string> = {
  reserved: 'dotReserved',
  working: 'dotWorking',
  offline: 'dotOffline',
}

export function Avatar({ uid, displayName, size = 28, status }: Props) {
  const bg = uidToColor(uid)
  const fontSize = Math.round(size * 0.46)

  return (
    <div
      className={styles.avatar}
      style={{ width: size, height: size, backgroundColor: bg, fontSize }}
    >
      <span className={styles.initial}>{getInitial(displayName)}</span>
      {status !== undefined && (
        <span className={`${styles.dot} ${styles[dotClass[status]]}`} />
      )}
    </div>
  )
}
