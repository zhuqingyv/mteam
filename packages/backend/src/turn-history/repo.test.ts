// turn-history repo/serializer 单测。不 mock：:memory: SQLite 真跑。
// 用 TEAM_HUB_V2_DB=:memory: + closeDb()/getDb() 在每个 case 前重置。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { getDb, closeDb } from '../db/connection.js';
import type {
  Turn,
  TurnBlock,
  ThinkingBlock,
  TextBlock,
  ToolCallBlock,
  PlanBlock,
  UsageBlock,
  CommandsBlock,
  ModeBlock,
  ConfigBlock,
  SessionInfoBlock,
} from '../agent-driver/turn-types.js';
import { turnToRow, rowToTurn } from './serializer.js';
import { insertTurn, listRecentByDriver, countByDriver, type TurnCursor } from './repo.js';

beforeEach(() => {
  closeDb();
  getDb();
});

afterAll(() => {
  closeDb();
});

// ---------- 构造器 ----------

function thinking(id: string, seq = 0): ThinkingBlock {
  return {
    blockId: id, type: 'thinking', scope: 'turn', status: 'done',
    seq, startTs: 't0', updatedTs: 't1', content: 'hmm',
  };
}
function text(id: string, seq = 1, content = 'hello'): TextBlock {
  return {
    blockId: id, type: 'text', scope: 'turn', status: 'done',
    seq, startTs: 't0', updatedTs: 't1', content,
  };
}
function toolCall(id: string, seq = 2): ToolCallBlock {
  return {
    blockId: id, type: 'tool_call', scope: 'turn', status: 'done',
    seq, startTs: 't0', updatedTs: 't1',
    toolCallId: 'tc-' + id, title: 'list_files',
    toolStatus: 'completed',
    input: { vendor: 'claude', display: 'ls /', data: { path: '/' } },
    output: { vendor: 'claude', display: '3 files', data: ['a', 'b', 'c'] },
  };
}
function plan(id: string, seq = 3): PlanBlock {
  return {
    blockId: id, type: 'plan', scope: 'turn', status: 'done',
    seq, startTs: 't0', updatedTs: 't1',
    entries: [{ content: 'step', priority: 'high', status: 'pending' }],
  };
}
function usageBlock(id: string, seq = 4): UsageBlock {
  return {
    blockId: id, type: 'usage', scope: 'turn', status: 'done',
    seq, startTs: 't0', updatedTs: 't1',
    used: 100, size: 200000, cost: { amount: 0.01, currency: 'USD' },
  };
}
function commandsBlock(id: string, seq = 5): CommandsBlock {
  return {
    blockId: id, type: 'commands', scope: 'session', status: 'done',
    seq, startTs: 't0', updatedTs: 't1',
    commands: [{ name: '/help', description: 'show help' }],
  };
}
function modeBlock(id: string, seq = 6): ModeBlock {
  return {
    blockId: id, type: 'mode', scope: 'session', status: 'done',
    seq, startTs: 't0', updatedTs: 't1', currentModeId: 'plan',
  };
}
function configBlock(id: string, seq = 7): ConfigBlock {
  return {
    blockId: id, type: 'config', scope: 'session', status: 'done',
    seq, startTs: 't0', updatedTs: 't1',
    options: [{ id: 'opt1', category: 'model', type: 'select', currentValue: 'sonnet' }],
  };
}
function sessionInfoBlock(id: string, seq = 8): SessionInfoBlock {
  return {
    blockId: id, type: 'session_info', scope: 'session', status: 'done',
    seq, startTs: 't0', updatedTs: 't1', title: 'session', updatedAt: 't1',
  };
}

function makeTurn(overrides: Partial<Turn> & Pick<Turn, 'turnId' | 'endTs'>): Turn {
  return {
    turnId: overrides.turnId,
    driverId: overrides.driverId ?? 'drv1',
    status: overrides.status ?? 'done',
    userInput: overrides.userInput ?? { text: 'hi', ts: '2026-04-25T10:00:00.000Z' },
    blocks: overrides.blocks ?? [text('b1', 0, 'reply')],
    stopReason: overrides.stopReason,
    usage: overrides.usage,
    startTs: overrides.startTs ?? '2026-04-25T10:00:00.000Z',
    endTs: overrides.endTs,
  };
}

// ---------- serializer ----------

describe('serializer turnToRow / rowToTurn', () => {
  it('圆环：Turn → Row → Turn 字段完全一致（含 9 种 TurnBlockType）', () => {
    const all: TurnBlock[] = [
      thinking('b0', 0), text('b1', 1), toolCall('b2', 2), plan('b3', 3),
      usageBlock('b4', 4), commandsBlock('b5', 5), modeBlock('b6', 6),
      configBlock('b7', 7), sessionInfoBlock('b8', 8),
    ];
    const turn = makeTurn({
      turnId: 'T1', endTs: '2026-04-25T10:00:01.000Z',
      blocks: all,
      stopReason: 'end_turn',
      usage: { totalTokens: 123, inputTokens: 100, outputTokens: 23 },
      userInput: { text: 'hi', ts: '2026-04-25T10:00:00.000Z' },
    });
    const row = turnToRow(turn);
    const back = rowToTurn(row);
    expect(back).toEqual(turn);
  });

  it('usage / stopReason undefined 且 attachments 缺省 → 圆环一致', () => {
    const turn = makeTurn({ turnId: 'T2', endTs: '2026-04-25T10:00:02.000Z' });
    expect(rowToTurn(turnToRow(turn))).toEqual(turn);
  });

  it('userInput 含 attachments → 圆环保留', () => {
    const turn = makeTurn({
      turnId: 'T3', endTs: '2026-04-25T10:00:03.000Z',
      userInput: {
        text: 'hi',
        ts: '2026-04-25T10:00:00.000Z',
        attachments: [{ kind: 'text', text: 'pasted' }],
      },
    });
    expect(rowToTurn(turnToRow(turn))).toEqual(turn);
  });

  it('active 状态 → turnToRow 抛错', () => {
    const bad: Turn = {
      turnId: 'T4', driverId: 'drv1', status: 'active',
      userInput: { text: 'hi', ts: 't0' }, blocks: [], startTs: 't0',
    };
    expect(() => turnToRow(bad)).toThrow();
  });

  it('finalized but 缺 endTs → 抛错', () => {
    const bad = { ...makeTurn({ turnId: 'T5', endTs: 't1' }), endTs: undefined } as Turn;
    expect(() => turnToRow(bad)).toThrow();
  });
});

// ---------- repo insert / listRecent ----------

describe('repo insertTurn / listRecentByDriver', () => {
  it('insert → listRecent 返回原 Turn（深相等）', () => {
    const turn = makeTurn({
      turnId: 'T1', endTs: '2026-04-25T10:00:01.000Z',
      blocks: [text('b1', 0, 'hi'), toolCall('b2', 1)],
    });
    insertTurn(turn);
    const { items, nextCursor } = listRecentByDriver('drv1', { limit: 10 });
    expect(items).toEqual([turn]);
    expect(nextCursor).toBeNull();
  });

  it('INSERT OR IGNORE：第二次不覆盖第一次', () => {
    const first = makeTurn({
      turnId: 'T1', endTs: '2026-04-25T10:00:01.000Z',
      status: 'done', blocks: [text('b1', 0, 'first')],
    });
    const second = makeTurn({
      turnId: 'T1', endTs: '2026-04-25T10:00:01.000Z',
      status: 'error', blocks: [text('b2', 0, 'second')], stopReason: 'crashed',
    });
    insertTurn(first);
    insertTurn(second);
    const { items } = listRecentByDriver('drv1', { limit: 10 });
    expect(items.length).toBe(1);
    expect(items[0]).toEqual(first);
  });

  it('不同 driver_id 互不污染', () => {
    insertTurn(makeTurn({ turnId: 'a1', driverId: 'A', endTs: '2026-04-25T10:00:01.000Z' }));
    insertTurn(makeTurn({ turnId: 'b1', driverId: 'B', endTs: '2026-04-25T10:00:02.000Z' }));
    expect(listRecentByDriver('A', { limit: 10 }).items.map((t) => t.turnId)).toEqual(['a1']);
    expect(listRecentByDriver('B', { limit: 10 }).items.map((t) => t.turnId)).toEqual(['b1']);
  });

  it('count：按 driver 计数', () => {
    insertTurn(makeTurn({ turnId: 'a1', driverId: 'A', endTs: '2026-04-25T10:00:01.000Z' }));
    insertTurn(makeTurn({ turnId: 'a2', driverId: 'A', endTs: '2026-04-25T10:00:02.000Z' }));
    insertTurn(makeTurn({ turnId: 'b1', driverId: 'B', endTs: '2026-04-25T10:00:01.000Z' }));
    expect(countByDriver('A')).toBe(2);
    expect(countByDriver('B')).toBe(1);
    expect(countByDriver('NO')).toBe(0);
  });
});

// ---------- keyset 分页 ----------

describe('repo listRecentByDriver 分页', () => {
  it('5 条 limit=2：翻页能完整取到所有 5 条，不重不漏', () => {
    for (let i = 1; i <= 5; i++) {
      insertTurn(
        makeTurn({ turnId: `T${i}`, endTs: `2026-04-25T10:00:0${i}.000Z` }),
      );
    }
    const p1 = listRecentByDriver('drv1', { limit: 2 });
    expect(p1.items.map((t) => t.turnId)).toEqual(['T5', 'T4']);
    expect(p1.nextCursor).toEqual({ endTs: '2026-04-25T10:00:04.000Z', turnId: 'T4' });

    const p2 = listRecentByDriver('drv1', { limit: 2, before: p1.nextCursor! });
    expect(p2.items.map((t) => t.turnId)).toEqual(['T3', 'T2']);
    expect(p2.nextCursor).toEqual({ endTs: '2026-04-25T10:00:02.000Z', turnId: 'T2' });

    const p3 = listRecentByDriver('drv1', { limit: 2, before: p2.nextCursor! });
    expect(p3.items.map((t) => t.turnId)).toEqual(['T1']);
    expect(p3.nextCursor).toBeNull();
  });

  it('同毫秒 3 条：limit=1 翻 3 页取完、无重无漏', () => {
    const sameTs = '2026-04-25T10:00:01.000Z';
    for (const id of ['Ta', 'Tb', 'Tc']) {
      insertTurn(makeTurn({ turnId: id, endTs: sameTs }));
    }
    const seen: string[] = [];
    let cursor: TurnCursor | undefined = undefined;
    for (let i = 0; i < 4; i++) {
      const p = listRecentByDriver('drv1', { limit: 1, before: cursor });
      if (p.items.length === 0) break;
      seen.push(p.items[0]!.turnId);
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect([...seen].sort()).toEqual(['Ta', 'Tb', 'Tc']);
    expect(new Set(seen).size).toBe(3);
    // 期望倒序：turn_id DESC → Tc, Tb, Ta
    expect(seen).toEqual(['Tc', 'Tb', 'Ta']);
  });

  it('不够 limit → nextCursor=null', () => {
    insertTurn(makeTurn({ turnId: 'T1', endTs: '2026-04-25T10:00:01.000Z' }));
    const p = listRecentByDriver('drv1', { limit: 10 });
    expect(p.items.length).toBe(1);
    expect(p.nextCursor).toBeNull();
  });

  it('空 driver → 空 items + null cursor', () => {
    const p = listRecentByDriver('nobody', { limit: 10 });
    expect(p.items).toEqual([]);
    expect(p.nextCursor).toBeNull();
  });
});

// ---------- 索引验证 ----------

describe('索引：EXPLAIN QUERY PLAN 走 idx_turn_hist_driver_end', () => {
  it('listRecentByDriver SQL 使用复合索引', () => {
    insertTurn(makeTurn({ turnId: 'T1', endTs: '2026-04-25T10:00:01.000Z' }));
    const db = getDb();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM turn_history
           WHERE driver_id = ?
           ORDER BY end_ts DESC, turn_id DESC
           LIMIT ?`,
      )
      .all('drv1', 10) as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail).toContain('idx_turn_hist_driver_end');
  });

  it('PRAGMA table_info 返回 9 列，列名匹配 schema', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(turn_history)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ['blocks', 'driver_id', 'end_ts', 'start_ts', 'status', 'stop_reason', 'turn_id', 'usage', 'user_input'].sort(),
    );
  });
});
