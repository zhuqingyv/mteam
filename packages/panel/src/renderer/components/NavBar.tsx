import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { pageAtom, sessionsAtom, workingCountAtom, onlineCountAtom, offlineCountAtom, mcpStoreAtom, activeProjectsCountAtom, type Page } from '../store/atoms'
import styles from './NavBar.module.css'

const tabs: { key: Page; label: string }[] = [
  { key: 'team', label: '团队' },
  { key: 'projects', label: '项目' },
  { key: 'store', label: '商店' },
]

export function NavBar() {
  const [page, setPage] = useAtom(pageAtom)
  const sessions = useAtomValue(sessionsAtom)
  const workingCount = useAtomValue(workingCountAtom)
  const onlineCount = useAtomValue(onlineCountAtom)
  const offlineCount = useAtomValue(offlineCountAtom)
  const { store } = useAtomValue(mcpStoreAtom)
  const activeProjects = useAtomValue(activeProjectsCountAtom)

  return (
    <div className={styles.nav}>
      <div className={styles.tabs}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`${styles.tab} ${page === tab.key ? styles.active : ''}`}
            onClick={() => setPage(tab.key)}
          >
            {tab.label}
            {tab.key === 'store' && store.length > 0 && (
              <span className={styles.badge}>{store.length}</span>
            )}
            {tab.key === 'projects' && activeProjects > 0 && (
              <span className={styles.badge}>{activeProjects}</span>
            )}
          </button>
        ))}
      </div>
      <div className={styles.stats}>
        {sessions.length} Claude · {workingCount}忙 · {onlineCount}在线 · {offlineCount}离线
      </div>
    </div>
  )
}
