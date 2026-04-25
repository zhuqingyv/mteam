import './TypingDots.css';

interface TypingDotsProps {
  color?: string;
}

export default function TypingDots({ color }: TypingDotsProps) {
  const style = color ? { background: color } : undefined;
  return (
    <span className="typing-dots">
      <span className="typing-dots__dot" style={style} />
      <span className="typing-dots__dot" style={style} />
      <span className="typing-dots__dot" style={style} />
    </span>
  );
}
