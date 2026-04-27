// Phase WS · W1-C：断线 gap 补发。纯函数：吃 MessageStore + lastMsgId + scope，
// 吐 WsDownstream.gap-replay。不碰 WS 连接、不 emit bus、不 import 业务代码。
//
// 冻结接口妥协（TASK-LIST W1-C §"关于冻结接口不改的妥协"）：
//   MessageStore.listTeamHistory 只有 before 游标（历史方向），gap 想要 after 方向；
//   本期不改 phase-comm 冻结签名 —— 取 before=null 拉最近一批再过滤 id > lastMsgId。
//   代价：单次最多 maxItems 条，超过靠翻页（upTo 指向本批最老一条，前端续拉）。
//
import type { MessageEnvelope } from '../comm/envelope.js';
import type { MessageStore } from '../comm/message-store.js';
import type { ClientSubscription } from './subscription-manager.js';

/**
 * gap-replayer 以 W1-B 冻结的 ClientSubscription 为输入形状；re-export 便于测试/调用方就近 import。
 */
export type GapReplayScope = ClientSubscription;

export interface GapReplayDeps {
  messageStore: MessageStore;
  /** 防滥用上限；超过后 upTo 指向本批最老一条，前端下次 subscribe 翻页续拉。 */
  maxItems?: number;
}

export interface GapQuery {
  lastMsgId: string | null;
  sub: GapReplayScope;
}

export interface GapReplayItem {
  id: string;
  event: Record<string, unknown>;
}

export interface GapReplayResult {
  type: 'gap-replay';
  items: GapReplayItem[];
  upTo: string | null;
}

const DEFAULT_MAX = 200;

/**
 * 把 envelope 序列化成 WS payload 列表。
 * 未读 envelope → 1 条 comm.message_sent；
 * 已读 envelope → 2 条 sent + received（W2-B：断线期间已读状态转换不丢）。
 * received 带 route='replay' 复用 router.emit 语义；ts 取 env.readAt。
 * 非 comm 状态事件（team.*, instance.*）重连走 HTTP 拉快照，不走 gap —— 见 MILESTONE §5.3。
 */
function envelopeToEvents(env: MessageEnvelope): Array<Record<string, unknown>> {
  const sent = {
    type: 'comm.message_sent',
    ts: env.ts,
    messageId: env.id,
    from: env.from.address,
    to: env.to.address,
  };
  if (env.readAt === null) return [sent];
  return [
    sent,
    {
      type: 'comm.message_received',
      ts: env.readAt,
      messageId: env.id,
      from: env.from.address,
      to: env.to.address,
      route: 'replay',
    },
  ];
}

/**
 * 从 envelope 列表中截出 lastMsgId 之后的切片。
 * envelopes 假定按 sent_at ASC, id ASC 升序；lastMsgId 不在列表里时按 ts 定位。
 */
function sliceAfter(
  envelopes: MessageEnvelope[],
  lastMsgId: string,
): MessageEnvelope[] {
  const idx = envelopes.findIndex((e) => e.id === lastMsgId);
  if (idx < 0) return envelopes; // lastMsgId 已读/超出本批 → 全部都算"之后"
  return envelopes.slice(idx + 1);
}

function fetchCandidates(
  store: MessageStore,
  sub: GapReplayScope,
  budget: number,
  lastMsgId: string,
): MessageEnvelope[] {
  const { scope, id } = sub;
  if (scope === 'team' && id) {
    // listTeamHistory 是 DESC 返回最近 N 条；拉 budget 条再倒序成 ASC。
    const { items } = store.listTeamHistory(id, { limit: budget });
    // items 是 InboxSummary（无 content），再用 findById 拿 envelope 保持 type 对齐。
    const asc: MessageEnvelope[] = [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const env = store.findById(items[i]!.id);
      if (env) asc.push(env);
    }
    return asc;
  }
  // instance/user 切到 findMessagesAfter（含已读，W2-B received 事件需要已读 envelope）。
  if (scope === 'instance' && id) {
    return store.findMessagesAfter(`local:${id}`, lastMsgId, budget);
  }
  if (scope === 'user' && id) {
    return store.findMessagesAfter(`user:${id}`, lastMsgId, budget);
  }
  // scope='global'：不支持 gap（跨 team/user/instance 无 SQL 过滤口，
  //   且非 comm 事件本就不补），重连走 HTTP 快照。返回空。
  return [];
}

/**
 * 构造 gap-replay 下行消息。
 *
 * scope 语义：
 *   - team:<id>     → listTeamHistory（desc → 倒序 → 过滤 id > lastMsgId）
 *   - instance:<id> → findUnreadForAddress('local:<id>')
 *   - user:<id>     → findUnreadForAddress('user:<id>')（W1-D 新方法）
 *   - global        → 不支持（重连走 HTTP 快照）；返回空
 *
 * 超量 gap 契约：单次最多 maxItems（默认 200）条；多出部分 upTo 指向"本批最老一条 id"，
 * 前端拿 upTo 当新 lastMsgId 再 subscribe 翻页。丑但有界。
 *
 * lastMsgId=null：返回 items=[]，upTo=null —— 首订阅不灌全表，前端要首屏自己调 HTTP。
 * 契约与 phase-comm listTeamHistory 的游标语义一致（null 视为"无缺"）。
 */
export function buildGapReplay(
  deps: GapReplayDeps,
  q: GapQuery,
): GapReplayResult {
  const maxItems = deps.maxItems ?? DEFAULT_MAX;

  if (q.lastMsgId === null) {
    return { type: 'gap-replay', items: [], upTo: null };
  }
  if (q.sub.scope === 'global' || q.sub.id === null) {
    return { type: 'gap-replay', items: [], upTo: null };
  }

  // 多拉一些候选，sliceAfter 之后才能知道真实 gap 大小；
  // 上限 maxItems*2+50 既覆盖"lastMsgId 在最近一批里"的常见情形，也避免无限膨胀。
  const budget = Math.min(maxItems * 2 + 50, 1000);
  const candidates = fetchCandidates(deps.messageStore, q.sub, budget, q.lastMsgId);
  // team scope 走 listTeamHistory 拿的是全量（含 lastMsgId 本身），仍要 sliceAfter；
  // instance/user 已经通过 findMessagesAfter 游标过滤，sliceAfter 对"未命中 lastMsgId"场景等价空切。
  const after = q.sub.scope === 'team' ? sliceAfter(candidates, q.lastMsgId) : candidates;

  if (after.length === 0) {
    return { type: 'gap-replay', items: [], upTo: null };
  }

  // W2-B：截断以 envelope 为边界 —— 不打断同一 envelope 的 sent/received pair。
  // upTo 仅记最后完整处理的 envelope id；第一个 envelope 就超限时 upTo=null，客户端下轮重试。
  const items: GapReplayItem[] = [];
  let lastFullEnvId: string | null = null;
  for (const env of after) {
    const evs = envelopeToEvents(env);
    if (items.length + evs.length > maxItems) break;
    for (const ev of evs) items.push({ id: env.id, event: ev });
    lastFullEnvId = env.id;
  }

  return { type: 'gap-replay', items, upTo: lastFullEnvId };
}
