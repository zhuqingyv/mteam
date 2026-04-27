import Modal from '../../atoms/Modal';
import Button from '../../atoms/Button';
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
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'default',
}: ConfirmDialogProps) {
  const handleCancel = () => onCancel?.();
  const handleConfirm = () => onConfirm?.();
  return (
    <Modal open={open} onClose={handleCancel} title={title} size="sm">
      <div className={`confirm-dialog confirm-dialog--${variant}`}>
        <p className="confirm-dialog__message">{message}</p>
        <div className="confirm-dialog__footer">
          <Button variant="ghost" size="md" onClick={handleCancel}>
            {cancelLabel}
          </Button>
          <div className="confirm-dialog__confirm">
            <Button variant="primary" size="md" onClick={handleConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
