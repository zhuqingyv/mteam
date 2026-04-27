import { useRef, useEffect } from 'react';
import Icon from '../../atoms/Icon';
import './ChatInput.css';

interface ChatInputProps {
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSend?: () => void;
}

export default function ChatInput({
  placeholder = '输入消息…',
  value = '',
  onChange,
  onSend,
}: ChatInputProps) {
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

  return (
    <div className="chat-input">
      <textarea
        ref={ref}
        className="chat-input__textarea"
        rows={1}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={handleKey}
      />
      <button
        type="button"
        className="chat-input__send"
        onClick={() => onSend?.()}
        disabled={!value.trim()}
        aria-label="发送"
      >
        <Icon name="send" size={16} />
      </button>
    </div>
  );
}
