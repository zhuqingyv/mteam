import CapsuleWindow from '../templates/CapsuleWindow';
import CapsuleCard from '../organisms/CapsuleCard';
import ExpandedView from '../organisms/ExpandedView';
import { useCapsuleToggle } from '../hooks/useCapsuleToggle';

export default function CapsulePage() {
  const { expanded, animating, toggle } = useCapsuleToggle();
  return (
    <CapsuleWindow>
      <CapsuleCard name="MTEAM" agentCount={4} taskCount={2} messageCount={3} online
        expanded={expanded} animating={animating} onToggle={toggle}>
        {expanded && <ExpandedView />}
      </CapsuleCard>
    </CapsuleWindow>
  );
}
