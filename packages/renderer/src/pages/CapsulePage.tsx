import CapsuleWindow from '../templates/CapsuleWindow';
import CapsuleCard from '../organisms/CapsuleCard';
import ExpandedView from '../organisms/ExpandedView';
import type { LogoStatus } from '../atoms/Logo';
import { useCapsuleToggle } from '../hooks/useCapsuleToggle';
import { useNotificationStore, usePrimaryAgentStore, selectOnline, selectAgentState, selectPaConfig } from '../store';

export default function CapsulePage() {
  const { expanded, animating, bodyVisible, toggle } = useCapsuleToggle();
  const notifications = useNotificationStore((s) => s.notifications);
  const acknowledgedIds = useNotificationStore((s) => s.acknowledgedIds);
  const online = usePrimaryAgentStore(selectOnline);
  const agentState = usePrimaryAgentStore(selectAgentState);
  const paStatus = usePrimaryAgentStore((s) => s.status);
  const lastError = usePrimaryAgentStore((s) => s.lastError);
  const config = usePrimaryAgentStore(selectPaConfig);
  const name = config?.name ?? 'MTEAM';

  // Phase 1：主 Agent 是唯一实体，online 即 1。
  const agentCount = online ? 1 : 0;
  // 主 Agent 正在跑 turn（非 idle 且 online）算 1 个任务。
  const taskCount = online && agentState !== 'idle' ? 1 : 0;
  const messageCount = notifications.filter((n) => !acknowledgedIds.includes(n.id)).length;

  // RUNNING → online；STOPPED && !lastError → connecting（WS/启动中）；STOPPED && lastError → offline。
  const logoStatus: LogoStatus = paStatus === 'RUNNING'
    ? 'online'
    : lastError
      ? 'offline'
      : 'connecting';

  return (
    <CapsuleWindow>
      <CapsuleCard
        name={name}
        agentCount={agentCount}
        taskCount={taskCount}
        messageCount={messageCount}
        online={online}
        logoStatus={logoStatus}
        expanded={expanded}
        animating={animating}
        bodyVisible={bodyVisible}
        onToggle={online ? toggle : undefined}
      >
        {(expanded || animating) && <ExpandedView />}
      </CapsuleCard>
    </CapsuleWindow>
  );
}
