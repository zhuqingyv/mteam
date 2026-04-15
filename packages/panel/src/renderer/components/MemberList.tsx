import React from 'react'
import { useAtomValue } from 'jotai'
import { membersAtom } from '../store/atoms'
import { Avatar } from './Avatar'
import styles from './MemberList.module.css'

interface Props {
  onMemberClick: (name: string) => void
}

function formatDuration(lockedAt: string): string {
  const diff = Date.now() - new Date(lockedAt).getTime()
  const totalMins = Math.floor(diff / 60000)
  if (totalMins < 1) return '<1m'
  if (totalMins < 60) return `${totalMins}m`
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '\u2026' : str
}

function groupByProject(members: MemberStatus[]): Map<string, MemberStatus[]> {
  const map = new Map<string, MemberStatus[]>()
  for (const m of members) {
    if (m.status !== 'working') continue
    const proj = m.project ?? '未知项目'
    if (!map.has(proj)) map.set(proj, [])
    map.get(proj)!.push(m)
  }
  return map
}

export function MemberList({ onMemberClick }: Props) {
  const members = useAtomValue(membersAtom)
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0)

  React.useEffect(() => {
    const id = setInterval(forceUpdate, 60000)
    return () => clearInterval(id)
  }, [])

  const reservedMembers = members.filter((m) => m.status === 'reserved')
  const workingGroups = groupByProject(members)
  const onlineMembers = members.filter((m) => m.status === 'online')
  const offlineMembers = members.filter((m) => m.status === 'offline')

  return (
    <div className={styles.list}>
      {/* 预约中 — 等待激活 */}
      {reservedMembers.length > 0 && (
        <div className={styles.projectGroup}>
          <div className={styles.projectHeader}>
            <span className={styles.projectName}>预约中</span>
          </div>
          {reservedMembers.map((member, idx) => (
            <div
              key={member.uid}
              className={`${styles.memberRow} ${styles.reservedRow} ${idx === reservedMembers.length - 1 ? styles.last : ''}`}
              onClick={() => onMemberClick(member.name)}
            >
              <Avatar uid={member.uid} displayName={member.displayName} size={24} status="reserved" />
              <span className={`${styles.memberName} ${member.type === 'temporary' ? styles.tempName : ''}`}>
                {member.displayName}
              </span>
              <span className={styles.taskText}>
                {member.caller ? `by ${truncate(member.caller, 8)}` : ''}{member.project ? ` · ${truncate(member.project, 8)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 工作中 — 按项目分组 */}
      {workingGroups.size > 0 ? (
        Array.from(workingGroups.entries()).map(([project, projectMembers]) => (
          <div key={project} className={styles.projectGroup}>
            <div className={styles.projectHeader}>
              <span className={styles.projectName}>{project}</span>
            </div>
            {projectMembers.map((member, idx) => (
              <div
                key={member.uid}
                className={`${styles.memberRow} ${idx === projectMembers.length - 1 ? styles.last : ''}`}
                onClick={() => onMemberClick(member.name)}
              >
                <Avatar uid={member.uid} displayName={member.displayName} size={24} status="working" />
                <span className={`${styles.memberName} ${member.type === 'temporary' ? styles.tempName : ''}`}>
                  {member.displayName}
                </span>
                <span className={styles.taskText}>
                  {truncate(member.task ?? '', 12)}
                </span>
                <span className={styles.duration}>
                  {member.lockedAt ? formatDuration(member.lockedAt) : ''}
                </span>
              </div>
            ))}
          </div>
        ))
      ) : (
        <div className={styles.emptyBusy}>暂无进行中的任务</div>
      )}

      {/* 在线 — 心跳活跃但无任务 */}
      {onlineMembers.length > 0 && (
        <div className={styles.idleSection}>
          <div className={styles.idleLabel}>在线</div>
          <div className={styles.idleGrid}>
            {onlineMembers.map((m) => (
              <div
                key={m.uid}
                className={styles.idleCard}
                onClick={() => onMemberClick(m.name)}
                title={m.name}
              >
                <Avatar uid={m.uid} displayName={m.displayName} size={32} status="online" />
                <span className={styles.idleName}>{m.displayName}</span>
                <span className={styles.idleRole}>{m.role}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 离线 */}
      {offlineMembers.length > 0 && (
        <div className={styles.idleSection}>
          <div className={styles.idleLabel}>离线</div>
          <div className={styles.idleGrid}>
            {offlineMembers.map((m) => (
              <div
                key={m.uid}
                className={styles.idleCard}
                onClick={() => onMemberClick(m.name)}
                title={m.name}
              >
                <Avatar uid={m.uid} displayName={m.displayName} size={32} status="offline" />
                <span className={styles.idleName}>{m.displayName}</span>
                <span className={styles.idleRole}>{m.role}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
