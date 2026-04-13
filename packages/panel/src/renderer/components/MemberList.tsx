import React from 'react'
import styles from './MemberList.module.css'

interface Props {
  members: MemberStatus[]
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
  return str.length > max ? str.slice(0, max) + '…' : str
}

// 按项目分组忙碌成员
function groupByProject(members: MemberStatus[]): Map<string, MemberStatus[]> {
  const map = new Map<string, MemberStatus[]>()
  for (const m of members) {
    if (!m.busy) continue
    const proj = m.project ?? '未知项目'
    if (!map.has(proj)) map.set(proj, [])
    map.get(proj)!.push(m)
  }
  return map
}

export function MemberList({ members }: Props) {
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0)

  // 每分钟刷新时长显示
  React.useEffect(() => {
    const id = setInterval(forceUpdate, 60000)
    return () => clearInterval(id)
  }, [])

  const busyGroups = groupByProject(members)
  const idleMembers = members.filter((m) => !m.busy)

  return (
    <div className={styles.list}>
      {/* 忙碌成员按项目分组 */}
      {busyGroups.size > 0 ? (
        Array.from(busyGroups.entries()).map(([project, projectMembers]) => (
          <div key={project} className={styles.projectGroup}>
            <div className={styles.projectHeader}>
              <span className={styles.projectIcon}>📂</span>
              <span className={styles.projectName}>{project}</span>
            </div>
            {projectMembers.map((member, idx) => (
              <div
                key={member.callName}
                className={`${styles.memberRow} ${idx === projectMembers.length - 1 ? styles.last : ''}`}
              >
                <span className={styles.treeChar}>{idx === projectMembers.length - 1 ? '└' : '├'}</span>
                <span
                  className={`${styles.memberName} ${member.type === 'temporary' ? styles.tempName : ''}`}
                >
                  {member.type === 'temporary' ? `临时:${member.name}` : member.name}
                </span>
                <span className={styles.busyDot} />
                <span className={styles.taskText}>
                  {truncate(member.task ?? '', 14)}
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

      {/* 空闲区 */}
      {idleMembers.length > 0 && (
        <div className={styles.idleSection}>
          <div className={styles.idleLabel}>💤 空闲</div>
          <div className={styles.idleNames}>
            {idleMembers.map((m) => (
              <span key={m.callName} className={styles.idleName}>
                {m.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
