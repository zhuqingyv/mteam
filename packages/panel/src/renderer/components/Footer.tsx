import React from 'react'
import styles from './Footer.module.css'

interface Props {
  sessionCount: number
  busyCount: number
  idleCount: number
}

export function Footer({ sessionCount, busyCount, idleCount }: Props) {
  return (
    <div className={styles.footer}>
      <span>⚡ {sessionCount} Claude</span>
      <span className={styles.sep}>·</span>
      <span>{busyCount}忙</span>
      <span className={styles.sep}>·</span>
      <span>{idleCount}闲</span>
    </div>
  )
}
