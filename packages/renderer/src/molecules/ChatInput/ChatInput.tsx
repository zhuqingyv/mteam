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

  const disabled = streaming ? false : !value.trim();
  const handleClick = () => {
    if (disabled) return;
    if (streaming) onStop?.();
    else onSend?.();
  };
  const handleSendKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleClick();
  };

  const sendCls = [
    'chat-input__send',
    streaming ? 'chat-input__send--stop' : '',
    disabled ? 'chat-input__send--disabled' : '',
  ].filter(Boolean).join(' ');

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
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        className={sendCls}
        onClick={handleClick}
        onKeyDown={handleSendKey}
        aria-disabled={disabled || undefined}
        aria-label={streaming ? t('common.stop') : t('common.send')}
      >
        <Icon name={streaming ? 'stop' : 'send'} size={16} />
      </div>
    </div>
  );
}
