import React, { useEffect, useState, useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { membersAtom, projectsAtom } from '../store/atoms'
import { Avatar } from './Avatar'
import styles from './ProjectDetail.module.css'

interface Props {
  projectId: string
  onBack: () => void
}

const STATUS_LIST: { key: ProjectStatus; label: string }[] = [
  { key: 'planning', label: '策划中' },
  { key: 'designing', label: '设计中' },
  { key: 'developing', label: '开发中' },
  { key: 'testing', label: '测试中' },
  { key: 'bugfixing', label: 'Bug修复' },
  { key: 'done', label: '完毕' },
  { key: 'abandoned', label: '废弃' },
]

const STATUS_COLORS: Record<ProjectStatus, string> = {
  planning: '#f59e0b', designing: '#8b5cf6', developing: '#3b82f6',
  testing: '#06b6d4', bugfixing: '#ef4444', done: '#22c55e', abandoned: '#6b7280'
}

type Tab = 'overview' | 'members' | 'rules'

export function ProjectDetail({ projectId, onBack }: Props) {
  const allMembers = useAtomValue(membersAtom)
  const setProjects = useSetAtom(projectsAtom)
  const [project, setProject] = useState<ProjectData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('overview')
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const load = useCallback(() => {
    window.teamHub.getProject(projectId).then((p) => {
      setProject(p)
      setLoading(false)
    })
  }, [projectId])

  useEffect(() => { load() }, [load])

  const save = useCallback(async (patch: Partial<ProjectData>) => {
    const updated = await window.teamHub.updateProject(projectId, patch)
    if (updated) setProject(updated)
    window.teamHub.listProjects().then(setProjects)
  }, [projectId, setProjects])

  const startEdit = (field: string, value: string) => {
    setEditing(field)
    setEditValue(value)
  }

  const commitEdit = (field: string) => {
    if (field === 'description' || field === 'experience') {
      save({ [field]: editValue })
    } else if (field === 'name') {
      save({ name: editValue })
    } else if (field === 'progress') {
      const n = Math.min(100, Math.max(0, parseInt(editValue) || 0))
      save({ progress: n })
    }
    setEditing(null)
  }

  const toggleMember = useCallback((memberName: string) => {
    if (!project) return
    const has = project.members.includes(memberName)
    const members = has ? project.members.filter((m) => m !== memberName) : [...project.members, memberName]
    save({ members })
  }, [project, save])

  const addListItem = useCallback((field: 'forbidden' | 'rules', value: string) => {
    if (!project || !value.trim()) return
    save({ [field]: [...project[field], value.trim()] })
  }, [project, save])

  const removeListItem = useCallback((field: 'forbidden' | 'rules', index: number) => {
    if (!project) return
    const list = [...project[field]]
    list.splice(index, 1)
    save({ [field]: list })
  }, [project, save])

  if (loading) {
    return <div className={styles.container}><div className={styles.loading}>加载中...</div></div>
  }
  if (!project) {
    return (
      <div className={styles.container}>
        <button className={styles.backBtn} onClick={onBack}>← 返回</button>
        <div className={styles.loading}>项目不存在</div>
      </div>
    )
  }

  const color = STATUS_COLORS[project.status]

  return (
    <div className={styles.container}>
      {/* 顶栏 */}
      <div className={styles.topBar}>
        <button className={styles.backBtn} onClick={onBack}>←</button>
        {editing === 'name' ? (
          <input
            className={styles.nameInput}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => commitEdit('name')}
            onKeyDown={(e) => e.key === 'Enter' && commitEdit('name')}
            autoFocus
          />
        ) : (
          <span className={styles.topName} onClick={() => startEdit('name', project.name)}>{project.name}</span>
        )}
      </div>

      {/* 状态选择 + 进度 */}
      <div className={styles.statusRow}>
        <div className={styles.statusSelect}>
          {STATUS_LIST.map((s) => (
            <button
              key={s.key}
              className={`${styles.statusBtn} ${project.status === s.key ? styles.statusActive : ''}`}
              style={project.status === s.key ? { background: STATUS_COLORS[s.key] + '20', color: STATUS_COLORS[s.key], borderColor: STATUS_COLORS[s.key] + '40' } : undefined}
              onClick={() => save({ status: s.key })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className={styles.progressRow}>
          <div className={styles.progressBarBig}>
            <div className={styles.progressFillBig} style={{ width: `${project.progress}%`, background: color }} />
          </div>
          {editing === 'progress' ? (
            <input
              className={styles.progressInput}
              type="number"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => commitEdit('progress')}
              onKeyDown={(e) => e.key === 'Enter' && commitEdit('progress')}
              autoFocus
            />
          ) : (
            <span className={styles.progressNum} onClick={() => startEdit('progress', String(project.progress))}>{project.progress}%</span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {(['overview', 'members', 'rules'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {{ overview: '概览', members: `成员(${project.members.length})`, rules: '规则' }[t]}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      <div className={styles.tabContent}>
        {tab === 'overview' && (
          <div className={styles.overviewContent}>
            <div className={styles.section}>
              <div className={styles.sectionLabel}>描述</div>
              {editing === 'description' ? (
                <textarea
                  className={styles.textarea}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commitEdit('description')}
                  autoFocus
                  rows={3}
                />
              ) : (
                <div
                  className={styles.sectionText}
                  onClick={() => startEdit('description', project.description)}
                >
                  {project.description || '点击添加描述...'}
                </div>
              )}
            </div>
            <div className={styles.section}>
              <div className={styles.sectionLabel}>项目经验</div>
              {editing === 'experience' ? (
                <textarea
                  className={styles.textarea}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commitEdit('experience')}
                  autoFocus
                  rows={4}
                />
              ) : (
                <div
                  className={styles.sectionText}
                  onClick={() => startEdit('experience', project.experience)}
                >
                  {project.experience || '点击记录项目经验...'}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'members' && (
          <div className={styles.memberContent}>
            <div className={styles.memberHint}>点击成员可切换加入/移除</div>
            <div className={styles.memberGrid}>
              {allMembers.map((m) => {
                const inProject = project.members.includes(m.name)
                return (
                  <div
                    key={m.uid}
                    className={`${styles.memberCard} ${inProject ? styles.memberIn : ''}`}
                    onClick={() => toggleMember(m.name)}
                  >
                    <Avatar uid={m.uid} displayName={m.name} size={28} status={m.status} />
                    <span className={styles.memberName}>{m.name}</span>
                    {inProject && <span className={styles.memberCheck}>✓</span>}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === 'rules' && (
          <div className={styles.rulesContent}>
            <RuleList
              title="绝对禁止"
              color="#ef4444"
              items={project.forbidden}
              onAdd={(v) => addListItem('forbidden', v)}
              onRemove={(i) => removeListItem('forbidden', i)}
            />
            <RuleList
              title="绝对遵循"
              color="#22c55e"
              items={project.rules}
              onAdd={(v) => addListItem('rules', v)}
              onRemove={(i) => removeListItem('rules', i)}
            />
          </div>
        )}
      </div>

      {/* 底部 */}
      <div className={styles.footer}>
        创建于 {project.created_at.slice(0, 10)} · 更新于 {project.updated_at.slice(0, 10)}
      </div>
    </div>
  )
}

function RuleList({ title, color, items, onAdd, onRemove }: {
  title: string; color: string; items: string[]
  onAdd: (v: string) => void; onRemove: (i: number) => void
}) {
  const [value, setValue] = useState('')
  return (
    <div className={styles.ruleSection}>
      <div className={styles.ruleTitle} style={{ color }}>{title}</div>
      {items.map((item, i) => (
        <div key={i} className={styles.ruleItem}>
          <span className={styles.ruleDot} style={{ background: color }} />
          <span className={styles.ruleText}>{item}</span>
          <button className={styles.ruleRemove} onClick={() => onRemove(i)}>×</button>
        </div>
      ))}
      <div className={styles.ruleAdd}>
        <input
          className={styles.ruleInput}
          placeholder={`添加${title}项...`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { onAdd(value); setValue('') } }}
        />
        <button className={styles.ruleAddBtn} onClick={() => { if (value.trim()) { onAdd(value); setValue('') } }}>+</button>
      </div>
    </div>
  )
}
