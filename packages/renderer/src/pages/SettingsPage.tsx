import PanelWindow from '../templates/PanelWindow';
import PrimaryAgentSettings from '../organisms/PrimaryAgentSettings';
import CliList from '../molecules/CliList';

export default function SettingsPage() {
  return (
    <PanelWindow>
      <div className="p-6 flex flex-col gap-6 max-w-[720px] mx-auto">
        <PrimaryAgentSettings />
        <CliList clis={[]} />
      </div>
    </PanelWindow>
  );
}
