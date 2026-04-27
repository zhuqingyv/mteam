import { describe, it, expect } from 'vitest';
import { assemblePrompt } from './prompt.js';

describe('assemblePrompt', () => {
  it('leader + 有 task：含 Leader 行 + task 原文', () => {
    const out = assemblePrompt({
      memberName: 'alice',
      isLeader: true,
      leaderName: null,
      persona: '架构师',
      task: '拆分模块并产出 TASK-LIST',
    });
    expect(out).toContain('# 系统提示');
    expect(out).toContain('本轮你被指派为 Leader。');
    expect(out).toContain('你的名字是：alice，你的身份是：架构师');
    expect(out).toContain('# 任务\n拆分模块并产出 TASK-LIST');
  });

  it('非 leader + 有 leaderName + 有 task', () => {
    const out = assemblePrompt({
      memberName: 'bob',
      isLeader: false,
      leaderName: 'alice',
      persona: '开发',
      task: '写 registry 模块',
    });
    expect(out).toContain('本轮你的 Leader 是 alice。');
    expect(out).toContain('你的名字是：bob，你的身份是：开发');
    expect(out).toContain('# 任务\n写 registry 模块');
    expect(out).not.toContain('本轮你被指派为 Leader。');
  });

  it('非 leader + 无 leaderName + 无 task', () => {
    const out = assemblePrompt({
      memberName: 'carol',
      isLeader: false,
      leaderName: null,
      persona: null,
      task: null,
    });
    expect(out).toContain('本轮你尚未绑定 Leader。');
    expect(out).toContain('你的名字是：carol，你的身份是：（未定义身份）');
    expect(out).toContain('（暂无具体任务，等待 Leader 分配）');
  });

  it('task 全空白 → 等价于无 task', () => {
    const out = assemblePrompt({
      memberName: 'dan',
      isLeader: false,
      leaderName: 'alice',
      persona: '测试',
      task: '   \n  ',
    });
    expect(out).toContain('（暂无具体任务，等待 Leader 分配）');
  });

  it('leaderName 空字符串 → 回落到未绑定', () => {
    const out = assemblePrompt({
      memberName: 'eve',
      isLeader: false,
      leaderName: '',
      persona: null,
      task: null,
    });
    expect(out).toContain('本轮你尚未绑定 Leader。');
  });
});
