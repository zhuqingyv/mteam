import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import { useLocale } from '../../i18n';
import './CanvasTopBar.css';

export interface CanvasTopBarProps {
  teamName: string;
  memberCount: number;
  zoomPercent: number;
  onZoomMenu?: () => void;
  onFit?: () => void;
  onNewMember?: () => void;
  onSettings?: () => void;
  onClose?: () => void;
}

export function formatZoomPercent(zoomPercent: number): number {
  if (!Number.isFinite(zoomPercent)) return 0;
  return Math.max(0, Math.min(300, Math.round(zoomPercent)));
}

export default function CanvasTopBar({
  teamName,
  memberCount,
  zoomPercent,
  onZoomMenu,
  onFit,
  onNewMember,
  onSettings,
  onClose,
}: CanvasTopBarProps) {
  const { t } = useLocale();
  const clampedPercent = formatZoomPercent(zoomPercent);
  return (
    <div className="canvas-top-bar">
      <div className="canvas-top-bar__left">
        <span className="canvas-top-bar__title">{teamName}</span>
        <span className="canvas-top-bar__sep" aria-hidden="true">·</span>
        <span className="canvas-top-bar__members">
          {t('canvas.members_count', { count: memberCount })}
        </span>
      </div>
      <div className="canvas-top-bar__right">
        <Button
          variant="icon"
          size="sm"
          className="canvas-top-bar__btn canvas-top-bar__zoom"
          ariaLabel={t('canvas.zoom_menu')}
          title={t('canvas.zoom_menu')}
          onClick={onZoomMenu}
        >
          <span className="canvas-top-bar__zoom-text">{clampedPercent}%</span>
        </Button>
        <Button
          variant="icon"
          size="sm"
          className="canvas-top-bar__btn"
          ariaLabel={t('canvas.fit')}
          title={t('canvas.fit')}
          onClick={onFit}
        >
          <Icon name="fit" size={14} />
        </Button>
        <Button
          variant="icon"
          size="sm"
          className="canvas-top-bar__btn canvas-top-bar__new"
          ariaLabel={t('canvas.new_member')}
          title={t('canvas.new_member')}
          onClick={onNewMember}
        >
          <Icon name="plus" size={14} />
          <span className="canvas-top-bar__new-text">{t('canvas.new_member')}</span>
        </Button>
        <Button
          variant="icon"
          size="sm"
          className="canvas-top-bar__btn"
          ariaLabel={t('common.settings')}
          title={t('common.settings')}
          onClick={onSettings}
        >
          <Icon name="settings" size={14} />
        </Button>
        <Button
          variant="icon"
          size="sm"
          className="canvas-top-bar__btn"
          ariaLabel={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </Button>
      </div>
    </div>
  );
}
