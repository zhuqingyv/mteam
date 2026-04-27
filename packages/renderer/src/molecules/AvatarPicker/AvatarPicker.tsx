import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import './AvatarPicker.css';

export interface AvatarRow {
  id: string;
  filename: string;
  builtin: boolean;
  createdAt?: string;
}

interface AvatarPickerProps {
  avatars: AvatarRow[];
  value: string | null;
  onChange: (id: string) => void;
  onRandom?: () => void;
  columns?: number;
  disabled?: boolean;
  loading?: boolean;
}

function resolveAvatarUrl(row: AvatarRow): string {
  if (row.builtin) {
    return new URL(`../../assets/avatars/${row.filename}`, import.meta.url).href;
  }
  return `/avatars/${row.filename}`;
}

export default function AvatarPicker({
  avatars,
  value,
  onChange,
  onRandom,
  columns = 5,
  disabled = false,
  loading = false,
}: AvatarPickerProps) {
  const cls = ['avatar-picker'];
  if (disabled) cls.push('avatar-picker--disabled');

  return (
    <div className={cls.join(' ')}>
      <div className="avatar-picker__header">
        <span className="avatar-picker__title">选择头像</span>
        {onRandom && (
          <Button variant="ghost" size="sm" onClick={disabled ? undefined : onRandom} disabled={disabled}>
            <span className="avatar-picker__random-label">
              <span className="avatar-picker__dice" aria-hidden="true">🎲</span>
              <span>随机</span>
            </span>
          </Button>
        )}
      </div>

      {loading ? (
        <div className="avatar-picker__grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
          {Array.from({ length: columns * 4 }).map((_, i) => (
            <div key={i} className="avatar-picker__skeleton" />
          ))}
        </div>
      ) : avatars.length === 0 ? (
        <div className="avatar-picker__empty">暂无头像，点击随机加载</div>
      ) : (
        <div
          className="avatar-picker__grid"
          role="radiogroup"
          aria-label="头像选择"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {avatars.map((avatar) => {
            const selected = avatar.id === value;
            const itemCls = ['avatar-picker__item'];
            if (selected) itemCls.push('avatar-picker__item--selected');
            return (
              <button
                type="button"
                key={avatar.id}
                className={itemCls.join(' ')}
                role="radio"
                aria-checked={selected}
                aria-label={`头像 ${avatar.id}`}
                onClick={() => !disabled && onChange(avatar.id)}
                disabled={disabled}
              >
                <img
                  className="avatar-picker__img"
                  src={resolveAvatarUrl(avatar)}
                  alt={avatar.id}
                  draggable={false}
                />
                {selected && (
                  <span className="avatar-picker__check" aria-hidden="true">
                    <Icon name="check" size={10} color="#fff" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
