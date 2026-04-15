import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { mcpStoreAtom, membersAtom } from '../store/atoms'
import { Avatar } from './Avatar'
import { LeadModal } from './LeadModal'
import styles from './MemberDetail.module.css'

interface Props {
  memberName: string
  onBack: () => void
}

type Tab = 'persona' | 'memory' | 'log' | 'config' | 'projects'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 简易 markdown 渲染
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let inCode = false
  let codeLines: string[] = []
  let key = 0

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        nodes.push(<pre key={key++} className={styles.codeBlock}>{codeLines.join('\n')}</pre>)
        codeLines = []
        inCode = false
      } else {
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }
    if (line.startsWith('# ')) {
      nodes.push(<h3 key={key++} className={styles.mdH1}>{line.slice(2)}</h3>)
    } else if (line.startsWith('## ')) {
      nodes.push(<h4 key={key++} className={styles.mdH2}>{line.slice(3)}</h4>)
    } else if (line.startsWith('### ')) {
      nodes.push(<h5 key={key++} className={styles.mdH3}>{line.slice(4)}</h5>)
    } else if (line.startsWith('- ')) {
      nodes.push(<div key={key++} className={styles.mdLi}>{line}</div>)
    } else if (line.trim() === '') {
      nodes.push(<div key={key++} className={styles.mdSpacer} />)
    } else {
      nodes.push(<div key={key++} className={styles.mdP}>{line}</div>)
    }
  }
  if (inCode && codeLines.length > 0) {
    nodes.push(<pre key={key++} className={styles.codeBlock}>{codeLines.join('\n')}</pre>)
  }
  return nodes
}

export function MemberDetail({ memberName, onBack }: Props) {
  const [detail, setDetail] = useState<MemberDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('persona')
  const { store } = useAtomValue(mcpStoreAtom)
  const members = useAtomValue(membersAtom)
  const liveMember = useMemo(() => members.find((m) => m.name === memberName), [members, memberName])
  const [mountedNames, setMountedNames] = useState<Set<string>>(new Set())
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  const [memberProjects, setMemberProjects] = useState<ProjectData[]>([])
  const [showLeadModal, setShowLeadModal] = useState(false)
  const [availableClis, setAvailableClis] = useState<boolean | null>(null) // null=未检测, true=有, false=无

  useEffect(() => {
    setLoading(true)
    window.teamHub.getMemberDetail(memberName).then((d) => {
      setDetail(d)
      setLoading(false)
    })
  }, [memberName])

  // 加载成员已挂载的 MCP
  useEffect(() => {
    window.teamHub.getMemberMcps(memberName).then((mcps) => {
      setMountedNames(new Set(mcps.map((m) => m.name)))
    })
  }, [memberName])

  // 加载成员参与的项目
  useEffect(() => {
    window.teamHub.getMemberProjects(memberName).then(setMemberProjects)
  }, [memberName])

  // 检测可用 CLI
  useEffect(() => {
    const check = async () => {
      try {
        const result = await (window as any).api?.scanAgentClis?.()
        setAvailableClis(result?.found?.length > 0)
      } catch {
        // IPC 未接入时 fallback 到 mock（mock 有 1 个 CLI）
        setAvailableClis(true)
      }
    }
    check()
  }, [])

  const handleToggle = useCallback(async (mcpName: string, mounted: boolean) => {
    setToggling((prev) => new Set(prev).add(mcpName))
    if (mounted) {
      await window.teamHub.unmountMemberMcp(memberName, mcpName)
    } else {
      await window.teamHub.mountMemberMcp(memberName, mcpName)
    }
    // 刷新
    const mcps = await window.teamHub.getMemberMcps(memberName)
    setMountedNames(new Set(mcps.map((m) => m.name)))
    setToggling((prev) => { const n = new Set(prev); n.delete(mcpName); return n })
  }, [memberName])

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>加载中...</div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={styles.container}>
        <button className={styles.backBtn} onClick={onBack}>← 返回</button>
        <div className={styles.loading}>成员不存在</div>
      </div>
    )
  }

  const { profile, persona, memory, workLog } = detail

  // 状态字段优先从实时 atom 读取，保持和首页列表一致；atom 未命中时回退到详情快照
  const status = liveMember?.status ?? detail.status
  const project = liveMember?.project ?? detail.project
  const task = liveMember?.task ?? detail.task
  const lastSeen = liveMember?.lastSeen ?? detail.lastSeen

  const statusLabel = { working: '工作中', online: '在线', offline: '离线', reserved: '预约中' }[status]
  const isLeadDisabled = status === 'working' || status === 'reserved' || availableClis === false
  const leadTooltip = availableClis === false ? '未检测到 agent CLI' : status === 'working' ? '成员正在工作中' : status === 'reserved' ? '成员已预约' : undefined

  return (
    <div className={styles.container}>
      {/* 顶栏 */}
      <div className={styles.topBar}>
        <button className={styles.backBtn} onClick={onBack}>←</button>
        <span className={styles.topName}>{profile.name}</span>
      </div>

      {/* Profile 卡片 */}
      <div className={styles.profileCard}>
        <Avatar uid={profile.uid} displayName={profile.name} size={56} status={status} />
        <div className={styles.profileInfo}>
          <div className={styles.displayName}>{profile.name}</div>
          <div className={styles.meta}>
            <span className={styles.roleBadge}>{profile.role}</span>
            {profile.type === 'temporary' && <span className={styles.tempBadge}>临时</span>}
          </div>
          <div className={styles.subMeta}>
            <span className={styles.uidLabel}>{profile.uid.slice(0, 8)}</span>
          </div>
        </div>
        <button
          className={styles.leadBtn}
          disabled={isLeadDisabled}
          title={leadTooltip}
          onClick={() => setShowLeadModal(true)}
        >
          &#62;_
        </button>
      </div>

      {/* 带队 Modal */}
      {showLeadModal && (
        <LeadModal
          memberName={profile.name}
          onClose={() => setShowLeadModal(false)}
        />
      )}

      {/* 状态 */}
      {status === 'working' && (
        <div className={styles.statusBar}>
          <span className={styles.statusDot} />
          <span className={styles.statusProject}>{project}</span>
          {task && <span className={styles.statusTask}>{task}</span>}
        </div>
      )}
      {status !== 'working' && lastSeen && (
        <div className={styles.statusBar}>
          <span className={styles.statusLabel}>{statusLabel}</span>
          <span className={styles.statusTask}>最后活跃: {formatTime(lastSeen)}</span>
        </div>
      )}

      {/* Tab */}
      <div className={styles.tabs}>
        {(['persona', 'memory', 'log', 'projects', 'config'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {{ persona: '角色', memory: '经验', log: '记录', projects: '项目', config: '配置' }[t]}
            {t === 'config' && mountedNames.size > 0 && (
              <span className={styles.configBadge}>{mountedNames.size}</span>
            )}
            {t === 'projects' && memberProjects.length > 0 && (
              <span className={styles.configBadge}>{memberProjects.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      <div className={styles.tabContent}>
        {tab === 'persona' && (
          persona
            ? <div className={styles.markdown}>{renderMarkdown(persona)}</div>
            : <div className={styles.empty}>暂无角色定义</div>
        )}
        {tab === 'memory' && (
          memory
            ? <div className={styles.markdown}>{renderMarkdown(memory)}</div>
            : <div className={styles.empty}>暂无积累经验</div>
        )}
        {tab === 'log' && (
          workLog.length > 0
            ? <div className={styles.logList}>
                {workLog.slice().reverse().map((entry, i) => (
                  <div key={i} className={styles.logEntry}>
                    <span className={`${styles.logEvent} ${entry.event === 'check_in' ? styles.logIn : styles.logOut}`}>
                      {entry.event === 'check_in' ? '签入' : '签出'}
                    </span>
                    <span className={styles.logProject}>{entry.project}</span>
                    {entry.task && <span className={styles.logTask}>{entry.task}</span>}
                    <span className={styles.logTime}>{formatTime(entry.timestamp)}</span>
                  </div>
                ))}
              </div>
            : <div className={styles.empty}>暂无工作记录</div>
        )}
        {tab === 'projects' && (
          memberProjects.length === 0
            ? <div className={styles.empty}>暂未参与项目</div>
            : <div className={styles.projectList}>
                {memberProjects.map((p) => (
                  <div key={p.id} className={styles.projectRow}>
                    <span className={styles.projectDot} style={{ background: p.status === 'done' ? '#22c55e' : p.status === 'abandoned' ? '#6b7280' : '#3b82f6' }} />
                    <span className={styles.projectRowName}>{p.name}</span>
                    <span className={styles.projectRowStatus}>{
                      { planning: '策划', designing: '设计', developing: '开发', testing: '测试', bugfixing: 'Bug修复', done: '完毕', abandoned: '废弃' }[p.status]
                    }</span>
                    <span className={styles.projectRowProgress}>{p.progress}%</span>
                  </div>
                ))}
              </div>
        )}
        {tab === 'config' && (
          store.length === 0
            ? <div className={styles.empty}>团队商店暂无 MCP，请先在商店中安装</div>
            : <div className={styles.mcpList}>
                {store.map((mcp) => {
                  const mounted = mountedNames.has(mcp.name)
                  const busy = toggling.has(mcp.name)
                  return (
                    <div key={mcp.name} className={`${styles.mcpRow} ${mounted ? styles.mcpMounted : ''}`}>
                      <div className={styles.mcpInfo}>
                        <div className={styles.mcpName}>{mcp.name}</div>
                        {mcp.description && <div className={styles.mcpDesc}>{mcp.description}</div>}
                      </div>
                      <button
                        className={mounted ? styles.mcpUnmountBtn : styles.mcpMountBtn}
                        disabled={busy}
                        onClick={() => handleToggle(mcp.name, mounted)}
                      >
                        {busy ? '...' : mounted ? '卸载' : '挂载'}
                      </button>
                    </div>
                  )
                })}
              </div>
        )}
      </div>

      {/* 底部信息 */}
      <div className={styles.footer}>
        加入于 {formatDate(profile.joined_at)}
      </div>
    </div>
  )
}
