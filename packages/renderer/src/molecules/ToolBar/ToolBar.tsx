import Dropdown, { type DropdownOption } from '../../atoms/Dropdown';
import Icon from '../../atoms/Icon';
import './ToolBar.css';

interface ToolBarProps {
  modelOptions: DropdownOption[];
  currentModel: string;
  onModelChange: (value: string) => void;
  onSettings?: () => void;
  onTeamPanel?: () => void;
  teamPanelActive?: boolean;
}

export default function ToolBar({
  modelOptions,
  currentModel,
  onModelChange,
  onSettings,
  onTeamPanel,
  teamPanelActive = false,
}: ToolBarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar__left">
        <Dropdown options={modelOptions} value={currentModel} onChange={onModelChange} />
      </div>
      <div className="toolbar__right">
        <button
          type="button"
          className="toolbar__icon-btn"
          onClick={onTeamPanel}
          aria-label="成员面板"
          title="成员面板"
          data-active={teamPanelActive ? 'true' : undefined}
        >
          <Icon name="team" size={14} />
        </button>
        <button
          type="button"
          className="toolbar__icon-btn"
          onClick={onSettings}
          aria-label="Settings"
        >
          <Icon name="settings" size={14} />
        </button>
      </div>
    </div>
  );
}
