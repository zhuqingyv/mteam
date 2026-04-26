import CapsuleWindow from '../templates/CapsuleWindow';
import CapsuleCard from '../organisms/CapsuleCard';
import ExpandedView from '../organisms/ExpandedView';
import { useCapsuleToggle } from '../hooks/useCapsuleToggle';
import { useAgentStore, useNotificationStore, usePrimaryAgentStore, selectOnline } from '../store';

export default function CapsulePage() {
  const { expanded, animating, toggle } = useCapsuleToggle();
  const agents = useAgentStore((s) => s.agents);
  const notifications = useNotificationStore((s) => s.notifications);
  const acknowledgedIds = useNotificationStore((s) => s.acknowledgedIds);
  const online = usePrimaryAgentStore(selectOnline);

  const agentCount = agents.length;
  const taskCount = agents.filter((a) => a.status === 'running').length;
  const messageCount = notifications.filter((n) => !acknowledgedIds.includes(n.id)).length;

  return (
    <CapsuleWindow>
      <CapsuleCard
        name="MTEAM"
        agentCount={agentCount}
        taskCount={taskCount}
        messageCount={messageCount}
        online={online}
        expanded={expanded}
        animating={animating}
        onToggle={toggle}
      >
        {expanded && <ExpandedView />}
      </CapsuleCard>
    </CapsuleWindow>
  );
}
