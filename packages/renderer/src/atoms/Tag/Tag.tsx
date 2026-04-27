import Icon from '../Icon';
import './Tag.css';

export type TagVariant = 'default' | 'primary' | 'danger';
export type TagSize = 'sm' | 'md';

interface TagProps {
  label: string;
  onRemove?: () => void;
  variant?: TagVariant;
  size?: TagSize;
  disabled?: boolean;
}

export default function Tag({
  label,
  onRemove,
  variant = 'default',
  size = 'md',
  disabled = false,
}: TagProps) {
  return (
    <span className={`tag tag--${variant} tag--${size}${disabled ? ' is-disabled' : ''}`}>
      <span className="tag__label">{label}</span>
      {onRemove ? (
        <button
          type="button"
          className="tag__remove"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`remove ${label}`}
        >
          <Icon name="close" size={size === 'sm' ? 10 : 12} />
        </button>
      ) : null}
    </span>
  );
}
