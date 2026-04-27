import CapsulePage from './pages/CapsulePage';
import TeamPage from './pages/TeamPage';
import SettingsPage from './pages/SettingsPage';
import { useWsEvents } from './hooks/useWsEvents';

const windowType =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('window')
    : null;

export default function App() {
  useWsEvents();
  switch (windowType) {
    case 'team': return <TeamPage />;
    case 'settings': return <SettingsPage />;
    default: return <CapsulePage />;
  }
}
