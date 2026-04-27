// turn-types 单测：纯类型守卫 + 联合类型形状断言。
// 不涉及 bus / driver / 业务，只验证守卫对 9 种 block 分类正确、scope 字段与 type 一致。
import { describe, it, expect } from 'bun:test';
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
  TurnBlockType,
} from '../turn-types.js';
import {
  isTurnBlockType,
  isSessionScopeBlock,
  isThinkingBlock,
  isTextBlock,
  isToolCallBlock,
  isPlanBlock,
  isUsageBlock,
  isCommandsBlock,
  isModeBlock,
  isConfigBlock,
  isSessionInfoBlock,
} from '../turn-types.js';

const TS = '2026-04-25T12:00:00.000Z';

function baseFields(seq: number) {
  return { seq, startTs: TS, updatedTs: TS, status: 'streaming' as const };
}

const thinking: ThinkingBlock = {
  ...baseFields(0),
  blockId: 'msg_1',
  type: 'thinking',
  scope: 'turn',
  messageId: 'msg_1',
  content: '思考中',
};

const text: TextBlock = {
  ...baseFields(1),
  blockId: 'msg_2',
  type: 'text',
  scope: 'turn',
  messageId: 'msg_2',
  content: 'hi',
};

const toolCall: ToolCallBlock = {
  ...baseFields(2),
  blockId: 'call_1',
  type: 'tool_call',
  scope: 'turn',
  toolCallId: 'call_1',
  title: 'Read x.txt',
  kind: 'read',
  toolStatus: 'in_progress',
  input: { vendor: 'codex', display: 'cat /tmp/x.txt', data: { cmd: 'cat' } },
};

const plan: PlanBlock = {
  ...baseFields(3),
  blockId: 'plan-turn_1',
  type: 'plan',
  scope: 'turn',
  entries: [{ content: 'step', priority: 'high', status: 'in_progress' }],
};

const usage: UsageBlock = {
  ...baseFields(4),
  blockId: 'usage-turn_1',
  type: 'usage',
  scope: 'turn',
  used: 100,
  size: 1000,
};

const commands: CommandsBlock = {
  ...baseFields(5),
  blockId: 'commands',
  type: 'commands',
  scope: 'session',
  commands: [{ name: '/help', description: 'show help' }],
};

const mode: ModeBlock = {
  ...baseFields(6),
  blockId: 'mode',
  type: 'mode',
  scope: 'session',
  currentModeId: 'default',
};

const config: ConfigBlock = {
  ...baseFields(7),
  blockId: 'config',
  type: 'config',
  scope: 'session',
  options: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'sonnet' },
  ],
};

const sessionInfo: SessionInfoBlock = {
  ...baseFields(8),
  blockId: 'session_info',
  type: 'session_info',
  scope: 'session',
  title: '我的会话',
};

const ALL_BLOCKS: TurnBlock[] = [
  thinking, text, toolCall, plan, usage, commands, mode, config, sessionInfo,
];

describe('isTurnBlockType', () => {
  it('所有 9 种官方 type 都通过', () => {
    const expected: TurnBlockType[] = [
      'thinking', 'text', 'tool_call', 'plan', 'usage',
      'commands', 'mode', 'config', 'session_info',
    ];
    for (const t of expected) expect(isTurnBlockType(t)).toBe(true);
  });

  it('未知字符串 / 非字符串拒绝', () => {
    expect(isTurnBlockType('unknown')).toBe(false);
    expect(isTurnBlockType('')).toBe(false);
    expect(isTurnBlockType(null)).toBe(false);
    expect(isTurnBlockType(undefined)).toBe(false);
    expect(isTurnBlockType(123)).toBe(false);
    expect(isTurnBlockType({ type: 'text' })).toBe(false);
  });
});

describe('isSessionScopeBlock', () => {
  it('commands/mode/config/session_info 返回 true', () => {
    expect(isSessionScopeBlock(commands)).toBe(true);
    expect(isSessionScopeBlock(mode)).toBe(true);
    expect(isSessionScopeBlock(config)).toBe(true);
    expect(isSessionScopeBlock(sessionInfo)).toBe(true);
  });

  it('turn 级 block 返回 false', () => {
    expect(isSessionScopeBlock(thinking)).toBe(false);
    expect(isSessionScopeBlock(text)).toBe(false);
    expect(isSessionScopeBlock(toolCall)).toBe(false);
    expect(isSessionScopeBlock(plan)).toBe(false);
    expect(isSessionScopeBlock(usage)).toBe(false);
  });

  it('与 block.scope 字段在全部 9 种 fixture 上一致', () => {
    for (const b of ALL_BLOCKS) {
      expect(isSessionScopeBlock(b)).toBe(b.scope === 'session');
    }
  });
});

describe('具体类型守卫', () => {
  it('每个守卫只对目标类型返回 true', () => {
    const cases: Array<[(b: TurnBlock) => boolean, TurnBlock]> = [
      [isThinkingBlock, thinking],
      [isTextBlock, text],
      [isToolCallBlock, toolCall],
      [isPlanBlock, plan],
      [isUsageBlock, usage],
      [isCommandsBlock, commands],
      [isModeBlock, mode],
      [isConfigBlock, config],
      [isSessionInfoBlock, sessionInfo],
    ];
    for (const [guard, target] of cases) {
      expect(guard(target)).toBe(true);
      for (const other of ALL_BLOCKS) {
        if (other === target) continue;
        expect(guard(other)).toBe(false);
      }
    }
  });

  it('守卫通过后可无强转访问独占字段（编译期）', () => {
    const b: TurnBlock = toolCall;
    if (isToolCallBlock(b)) {
      expect(b.toolCallId).toBe('call_1');
      expect(b.input.vendor).toBe('codex');
    } else {
      throw new Error('应命中 tool_call');
    }
  });
});

describe('Turn 形状', () => {
  it('可装配一个完整 Turn', () => {
    const turn: Turn = {
      turnId: 'turn_1',
      driverId: 'inst_1',
      status: 'done',
      userInput: { text: 'hi', ts: TS },
      blocks: ALL_BLOCKS,
      stopReason: 'end_turn',
      usage: { totalTokens: 123 },
      startTs: TS,
      endTs: TS,
    };
    expect(turn.blocks).toHaveLength(9);
    expect(turn.blocks.filter((b) => b.scope === 'turn')).toHaveLength(5);
    expect(turn.blocks.filter((b) => b.scope === 'session')).toHaveLength(4);
  });
});
