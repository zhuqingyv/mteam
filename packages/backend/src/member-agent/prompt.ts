export interface AssemblePromptInput {
  memberName: string;
  isLeader: boolean;
  leaderName: string | null;
  persona: string | null;
  task: string | null;
}

const HEADER = [
  '# 系统提示',
  '一定永远思考用户真正的需求，不懂立刻问，不要为了完成眼下任务偏离真正的需求！！！',
  '',
  '你是 M-Team 体系内的一个 Agent。你的工作围绕两件事展开：',
  '1、利用 mnemo 完成用户的任何任务',
  '2、围绕 mteam 完成团队协作',
].join('\n');

function roleLine(isLeader: boolean, leaderName: string | null): string {
  if (isLeader) return '本轮你被指派为 Leader。';
  if (leaderName && leaderName.length > 0) return `本轮你的 Leader 是 ${leaderName}。`;
  return '本轮你尚未绑定 Leader。';
}

function taskSection(task: string | null): string {
  if (!task || task.trim().length === 0) {
    return '# 任务\n（暂无具体任务，等待 Leader 分配）';
  }
  return `# 任务\n${task}`;
}

export function assemblePrompt(input: AssemblePromptInput): string {
  const persona = input.persona ?? '（未定义身份）';
  const role = [
    '# 角色',
    roleLine(input.isLeader, input.leaderName),
    `你的名字是：${input.memberName}，你的身份是：${persona}`,
  ].join('\n');

  return [HEADER, role, taskSection(input.task)].join('\n\n');
}
