import CapsulePage from './pages/CapsulePage';
import TeamPage from './pages/TeamPage';
import SettingsPage from './pages/SettingsPage';
import RoleListPage from './pages/RoleListPage';
import { useWsEvents } from './hooks/useWsEvents';
import { useMessageStore } from './store/messageStore';
import { useTeamStore } from './store/teamStore';
import { useAgentStore } from './store/agentStore';
import { usePrimaryAgentStore } from './store/primaryAgentStore';

const windowType =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('window')
    : null;

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__messageStore = useMessageStore;
  window.__teamStore = useTeamStore;
  window.__agentStore = useAgentStore;
  window.__primaryAgentStore = usePrimaryAgentStore;
}

export default function App() {
  useWsEvents();
  switch (windowType) {
    case 'team': return <TeamPage />;
    case 'settings': return <SettingsPage />;
    case 'roles': return <RoleListPage />;
    default: return <CapsulePage />;
  }
}
