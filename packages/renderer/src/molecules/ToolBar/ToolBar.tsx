import Dropdown, { type DropdownOption } from '../../atoms/Dropdown';
import Icon from '../../atoms/Icon';
import { useLocale } from '../../i18n';
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
  const { t } = useLocale();
  const teamLabel = t('toolbar.team_panel');
  const settingsLabel = t('toolbar.settings');
  const invokeOnEnterOrSpace =
    (handler?: () => void) => (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      handler?.();
    };
  return (
    <div className="toolbar">
      <div className="toolbar__left">
        <Dropdown options={modelOptions} value={currentModel} onChange={onModelChange} />
      </div>
      <div className="toolbar__right">
        <div
          role="button"
          tabIndex={0}
          className="toolbar__icon-btn"
          onClick={onTeamPanel}
          onKeyDown={invokeOnEnterOrSpace(onTeamPanel)}
          aria-label={teamLabel}
          title={teamLabel}
          data-active={teamPanelActive ? 'true' : undefined}
        >
          <Icon name="team" size={14} />
        </div>
        <div
          role="button"
          tabIndex={0}
          className="toolbar__icon-btn"
          onClick={onSettings}
          onKeyDown={invokeOnEnterOrSpace(onSettings)}
          aria-label={settingsLabel}
          title={settingsLabel}
        >
          <Icon name="settings" size={14} />
        </div>
      </div>
    </div>
  );
}
