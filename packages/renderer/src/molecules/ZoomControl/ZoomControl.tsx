import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import { useLocale } from '../../i18n';
import './ZoomControl.css';

export interface ZoomControlProps {
  zoom: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onReset?: () => void;
}

export function zoomToPercent(zoom: number): number {
  if (!Number.isFinite(zoom)) return 0;
  return Math.max(0, Math.min(300, Math.round(zoom * 100)));
}

export default function ZoomControl({ zoom, onZoomIn, onZoomOut, onReset }: ZoomControlProps) {
  const { t } = useLocale();
  const percent = zoomToPercent(zoom);
  return (
    <div className="zoom-control" role="group" aria-label={t('canvas.zoom_menu')}>
      <Button
        variant="icon"
        size="sm"
        className="zoom-control__btn zoom-control__btn--minus"
        ariaLabel={t('canvas.zoom_out')}
        title={t('canvas.zoom_out')}
        onClick={onZoomOut}
      >
        <Icon name="minus" size={14} />
      </Button>
      <Button
        variant="icon"
        size="sm"
        className="zoom-control__value"
        ariaLabel={t('canvas.zoom_reset')}
        title={t('canvas.zoom_reset')}
        onDoubleClick={onReset}
      >
        <span className="zoom-control__value-text">{percent}%</span>
      </Button>
      <Button
        variant="icon"
        size="sm"
        className="zoom-control__btn zoom-control__btn--plus"
        ariaLabel={t('canvas.zoom_in')}
        title={t('canvas.zoom_in')}
        onClick={onZoomIn}
      >
        <Icon name="plus" size={14} />
      </Button>
    </div>
  );
}
