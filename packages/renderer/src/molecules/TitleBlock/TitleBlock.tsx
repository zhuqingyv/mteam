import Text from '../../atoms/Text';
import './TitleBlock.css';

interface TitleBlockProps {
  title: string;
  subtitle?: string;
  badgeText?: string;
  badgeCount?: number;
}

export default function TitleBlock({ title, subtitle, badgeText, badgeCount = 0 }: TitleBlockProps) {
  return (
    <div className="title-block">
      <Text variant="title">{title}</Text>
      {subtitle && (
        <>
          <span className="title-block__sr-sep">{' '}</span>
          <Text variant="subtitle">{subtitle}</Text>
        </>
      )}
      {badgeText && (
        <Text variant="badge">
          {badgeText}
          {badgeCount > 0 && <span className="title-block__dot" />}
        </Text>
      )}
    </div>
  );
}
