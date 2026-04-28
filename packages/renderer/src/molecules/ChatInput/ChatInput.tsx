import { useRef, useEffect } from 'react';
import Icon from '../../atoms/Icon';
import { useLocale } from '../../i18n';
import './ChatInput.css';

interface ChatInputProps {
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSend?: () => void;
  streaming?: boolean;
  onStop?: () => void;
}

export default function ChatInput({
  placeholder,
  value = '',
  onChange,
  onSend,
  streaming = false,
  onStop,
}: ChatInputProps) {
  const { t } = useLocale();
  const resolvedPlaceholder = placeholder ?? t('chat.placeholder_generic');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [value]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend?.();
    }
  };

  const handleClick = () => {
    if (streaming) onStop?.();
    else onSend?.();
  };

  return (
    <div className="chat-input" data-streaming={streaming ? 'true' : undefined}>
      <textarea
        ref={ref}
        className="chat-input__textarea"
        rows={1}
        placeholder={resolvedPlaceholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={handleKey}
      />
      <button
        type="button"
        className={`chat-input__send${streaming ? ' chat-input__send--stop' : ''}`}
        onClick={handleClick}
        disabled={streaming ? false : !value.trim()}
        aria-label={streaming ? t('common.stop') : t('common.send')}
      >
        <Icon name={streaming ? 'stop' : 'send'} size={16} />
      </button>
    </div>
  );
}
