import './TextBlock.css';

interface TextBlockProps {
  content: string;
  streaming?: boolean;
}

export default function TextBlock({ content, streaming }: TextBlockProps) {
  return (
    <span className="text-block">
      {content}
      {streaming && <span className="text-block__cursor" />}
    </span>
  );
}
