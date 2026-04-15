import React from 'react'
import { useAtomValue } from 'jotai'
import { sessionsAtom, teamStatusAtom, healthyAtom } from '../store/atoms'
import styles from './Header.module.css'

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 5) return '刚刚'
  if (secs < 60) return `${secs}s前`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m前`
  return `${Math.floor(mins / 60)}h前`
}

export function Header() {
  const sessions = useAtomValue(sessionsAtom)
  const status = useAtomValue(teamStatusAtom)
  const healthy = useAtomValue(healthyAtom)
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0)

  // 每秒刷新相对时间
  React.useEffect(() => {
    const id = setInterval(forceUpdate, 1000)
    return () => clearInterval(id)
  }, [])

  const scannedAt = status?.scannedAt ?? ''
  const errorMsg = status?.errorMsg

  return (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <span
          className={styles.dot}
          style={{ background: healthy ? 'var(--dot-green)' : 'var(--dot-red)' }}
        />
        <span className={styles.title}>Team Hub</span>
        <span className={styles.sessionBadge}>{sessions.length} sessions</span>
      </div>
      <div className={styles.statusRow}>
        <span className={styles.scanTime}>刷新: {scannedAt ? formatRelativeTime(scannedAt) : '-'}</span>
        <span className={styles.healthStatus}>
          {healthy ? '✅ 正常' : `⚠️ ${errorMsg ?? '异常'}`}
        </span>
      </div>
    </div>
  )
}
