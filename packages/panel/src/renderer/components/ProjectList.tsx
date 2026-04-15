import React, { useState, useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { projectsAtom, selectedProjectAtom, membersAtom } from '../store/atoms'
import { Avatar } from './Avatar'
import styles from './ProjectList.module.css'

const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: '策划中', designing: '设计中', developing: '开发中',
  testing: '测试中', bugfixing: 'Bug修复', done: '完毕', abandoned: '废弃'
}

const STATUS_COLORS: Record<ProjectStatus, string> = {
  planning: '#f59e0b', designing: '#8b5cf6', developing: '#3b82f6',
  testing: '#06b6d4', bugfixing: '#ef4444', done: '#22c55e', abandoned: '#6b7280'
}

export function ProjectList() {
  const projects = useAtomValue(projectsAtom)
  const members = useAtomValue(membersAtom)
  const setSelected = useSetAtom(selectedProjectAtom)
  const setProjects = useSetAtom(projectsAtom)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const refreshProjects = useCallback(() => {
    window.teamHub.listProjects().then(setProjects)
  }, [setProjects])

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return
    await window.teamHub.createProject({
      name: newName.trim(),
      description: '',
      status: 'planning',
      progress: 0,
      members: [],
      experience: '',
      forbidden: [],
      rules: []
    })
    setNewName('')
    setCreating(false)
    refreshProjects()
  }, [newName, refreshProjects])

  const getMemberInfo = (name: string) => members.find((m) => m.name === name)

  return (
    <div className={styles.container}>
      {/* 顶部创建 */}
      <div className={styles.toolbar}>
        {creating ? (
          <div className={styles.createRow}>
            <input
              className={styles.createInput}
              placeholder="项目名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <button className={styles.createConfirm} onClick={handleCreate}>创建</button>
            <button className={styles.createCancel} onClick={() => { setCreating(false); setNewName('') }}>取消</button>
          </div>
        ) : (
          <button className={styles.addBtn} onClick={() => setCreating(true)}>+ 新建项目</button>
        )}
      </div>

      {projects.length === 0 && !creating ? (
        <div className={styles.empty}>
          <div className={styles.emptyText}>暂无项目</div>
          <div className={styles.emptyHint}>点击「新建项目」开始</div>
        </div>
      ) : (
        <div className={styles.list}>
          {projects.map((p) => (
            <div key={p.id} className={styles.card} onClick={() => setSelected(p.id)}>
              <div className={styles.cardTop}>
                <span className={styles.projectName}>{p.name}</span>
                <span className={styles.statusTag} style={{ background: STATUS_COLORS[p.status] + '18', color: STATUS_COLORS[p.status] }}>
                  {STATUS_LABELS[p.status]}
                </span>
              </div>
              {p.description && <div className={styles.desc}>{p.description}</div>}
              {/* 进度条 */}
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${p.progress}%`, background: STATUS_COLORS[p.status] }} />
              </div>
              <div className={styles.cardBottom}>
                <div className={styles.memberAvatars}>
                  {p.members.slice(0, 5).map((name) => {
                    const m = getMemberInfo(name)
                    return <Avatar key={name} uid={m?.uid ?? name} displayName={m?.name ?? name} size={18} />
                  })}
                  {p.members.length > 5 && <span className={styles.moreMembers}>+{p.members.length - 5}</span>}
                  {p.members.length === 0 && <span className={styles.noMembers}>无成员</span>}
                </div>
                <span className={styles.progressText}>{p.progress}%</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
