import React from 'react'
import styles from './Header.module.css'

interface Props {
  sessionCount: number
  scannedAt: string
  healthy: boolean
  errorMsg?: string
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 5) return '刚刚'
  if (secs < 60) return `${secs}s前`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m前`
  return `${Math.floor(mins / 60)}h前`
}

export function Header({ sessionCount, scannedAt, healthy, errorMsg }: Props) {
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0)

  // 每秒刷新相对时间
  React.useEffect(() => {
    const id = setInterval(forceUpdate, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <span
          className={styles.dot}
          style={{ background: healthy ? 'var(--dot-green)' : 'var(--dot-red)' }}
        />
        <span className={styles.title}>Team Hub</span>
        <span className={styles.sessionBadge}>{sessionCount} sessions</span>
      </div>
      <div className={styles.statusRow}>
        <span className={styles.scanTime}>刷新: {formatRelativeTime(scannedAt)}</span>
        <span className={styles.healthStatus}>
          {healthy ? '✅ 正常' : `⚠️ ${errorMsg ?? '异常'}`}
        </span>
      </div>
    </div>
  )
}
