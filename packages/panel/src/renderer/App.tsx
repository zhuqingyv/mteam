import React from 'react'
import { Provider, useAtomValue, useSetAtom } from 'jotai'
import { pageAtom, selectedMemberAtom, selectedProjectAtom, teamStatusAtom } from './store/atoms'
import { IpcBridge } from './store/IpcBridge'
import { Header } from './components/Header'
import { MemberList } from './components/MemberList'
import { MemberDetail } from './components/MemberDetail'
import { McpStore } from './components/McpStore'
import { ProjectList } from './components/ProjectList'
import { ProjectDetail } from './components/ProjectDetail'
import { NavBar } from './components/NavBar'

function AppInner() {
  const status = useAtomValue(teamStatusAtom)
  const page = useAtomValue(pageAtom)
  const selectedMember = useAtomValue(selectedMemberAtom)
  const setSelectedMember = useSetAtom(selectedMemberAtom)
  const selectedProject = useAtomValue(selectedProjectAtom)
  const setSelectedProject = useSetAtom(selectedProjectAtom)

  if (!status) {
    return (
      <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--text-idle)', fontSize: 12 }}>加载中...</span>
      </div>
    )
  }

  // 成员详情页
  if (selectedMember) {
    return (
      <div className="panel">
        <MemberDetail
          memberName={selectedMember}
          onBack={() => setSelectedMember(null)}
        />
      </div>
    )
  }

  // 项目详情页
  if (selectedProject) {
    return (
      <div className="panel">
        <ProjectDetail
          projectId={selectedProject}
          onBack={() => setSelectedProject(null)}
        />
      </div>
    )
  }

  return (
    <div className="panel">
      <Header />
      {page === 'team' && (
        <MemberList onMemberClick={(name) => setSelectedMember(name)} />
      )}
      {page === 'projects' && <ProjectList />}
      {page === 'store' && <McpStore />}
      <NavBar />
    </div>
  )
}

export default function App() {
  return (
    <Provider>
      <IpcBridge />
      <AppInner />
    </Provider>
  )
}
