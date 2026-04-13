import React from 'react'
import { useTeamStatus } from './hooks/useTeamStatus'
import { Header } from './components/Header'
import { MemberList } from './components/MemberList'
import { Footer } from './components/Footer'

export default function App() {
  const { status } = useTeamStatus()

  if (!status) {
    return (
      <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--text-idle)', fontSize: 12 }}>加载中...</span>
      </div>
    )
  }

  const busyCount = status.members.filter((m) => m.busy).length
  const idleCount = status.members.filter((m) => !m.busy).length

  return (
    <div className="panel">
      <Header
        sessionCount={status.sessions.length}
        scannedAt={status.scannedAt}
        healthy={status.healthy}
        errorMsg={status.errorMsg}
      />
      <MemberList members={status.members} />
      <Footer
        sessionCount={status.sessions.length}
        busyCount={busyCount}
        idleCount={idleCount}
      />
    </div>
  )
}
