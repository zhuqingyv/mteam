// ── Types ─────────────────────────────────────────────────────────────────────

export interface Message {
  id: string
  from: string
  to: string
  content: string
  priority: 'normal' | 'urgent'
  timestamp: number
  status: 'pending' | 'delivered' | 'expired'
}

// ── Internal storage ──────────────────────────────────────────────────────────

// key: memberId (to), value: ordered queue
const queues = new Map<string, Message[]>()

function getQueue(memberId: string): Message[] {
  let q = queues.get(memberId)
  if (!q) {
    q = []
    queues.set(memberId, q)
  }
  return q
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * 入队一条消息，返回消息 id。
 * urgent 消息插到队首（urgent 内部按 FIFO），normal 消息追加队尾。
 */
export function enqueue(
  msg: Omit<Message, 'id' | 'timestamp' | 'status'>
): string {
  const id = crypto.randomUUID()
  const full: Message = {
    ...msg,
    id,
    timestamp: Date.now(),
    status: 'pending'
  }
  const q = getQueue(msg.to)
  if (msg.priority === 'urgent') {
    // 插入到所有 normal 消息之前（但在已有 urgent 消息之后）
    const insertIdx = q.findIndex((m) => m.priority === 'normal')
    if (insertIdx === -1) {
      q.push(full)
    } else {
      q.splice(insertIdx, 0, full)
    }
  } else {
    q.push(full)
  }
  return id
}

/**
 * 取队首消息投递。
 * 合并规则：扫描队首连续的同一 from 的消息，合并为一条投递。
 * 返回合并后的消息（content 以换行拼接），或 null（队空）。
 */
export function dequeue(memberId: string): Message | null {
  const q = getQueue(memberId)
  if (q.length === 0) return null

  const first = q[0]
  const sameFrom: Message[] = [first]

  // 扫描队首连续的相同 from
  let i = 1
  while (i < q.length && q[i].from === first.from) {
    sameFrom.push(q[i])
    i++
  }

  // 从队列移除这些消息
  q.splice(0, sameFrom.length)

  if (sameFrom.length === 1) {
    first.status = 'delivered'
    return first
  }

  // 合并为一条
  const merged: Message = {
    id: first.id,
    from: first.from,
    to: first.to,
    content: sameFrom.map((m) => m.content).join('\n'),
    priority: sameFrom.some((m) => m.priority === 'urgent') ? 'urgent' : 'normal',
    timestamp: first.timestamp,
    status: 'delivered'
  }
  return merged
}

/**
 * 查看成员队列中所有待投递消息（不修改队列）。
 */
export function peekAll(memberId: string): Message[] {
  return [...getQueue(memberId)]
}

/**
 * 清空成员队列。
 */
export function clearQueue(memberId: string): void {
  queues.set(memberId, [])
}

/**
 * 清理超时消息（status 改为 expired 并移出队列）。
 */
export function expireSweep(ttlMs: number): void {
  const now = Date.now()
  for (const [memberId, q] of queues) {
    const remaining = q.filter((m) => {
      if (now - m.timestamp > ttlMs) {
        m.status = 'expired'
        return false
      }
      return true
    })
    queues.set(memberId, remaining)
  }
}
