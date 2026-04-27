import Dropdown, { type DropdownOption } from '../../atoms/Dropdown';
import Icon from '../../atoms/Icon';
import './ToolBar.css';

interface ToolBarProps {
  modelOptions: DropdownOption[];
  currentModel: string;
  onModelChange: (value: string) => void;
  onSettings?: () => void;
}

export default function ToolBar({
  modelOptions,
  currentModel,
  onModelChange,
  onSettings,
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
          onClick={onSettings}
          aria-label="Settings"
        >
          <Icon name="settings" size={14} />
        </button>
      </div>
    </div>
  );
}
