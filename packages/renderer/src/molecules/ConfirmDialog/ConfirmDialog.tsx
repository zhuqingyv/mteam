import Modal from '../../atoms/Modal';
import Button from '../../atoms/Button';
import { useLocale } from '../../i18n';
import './ConfirmDialog.css';

interface ConfirmDialogProps {
  open: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
}

export default function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'default',
}: ConfirmDialogProps) {
  const { t } = useLocale();
  const resolvedConfirm = confirmLabel ?? t('common.confirm');
  const resolvedCancel = cancelLabel ?? t('common.cancel');
  const handleCancel = () => onCancel?.();
  const handleConfirm = () => onConfirm?.();
  return (
    <Modal open={open} onClose={handleCancel} title={title} size="sm">
      <div className={`confirm-dialog confirm-dialog--${variant}`}>
        <p className="confirm-dialog__message">{message}</p>
        <div className="confirm-dialog__footer">
          <Button variant="ghost" size="md" onClick={handleCancel}>
            {resolvedCancel}
          </Button>
          <div className="confirm-dialog__confirm">
            <Button variant="primary" size="md" onClick={handleConfirm}>
              {resolvedConfirm}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
