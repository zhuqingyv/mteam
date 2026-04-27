import './Icon.css';

type IconName =
  | 'close'
  | 'send'
  | 'chevron'
  | 'chevron-down'
  | 'settings'
  | 'plus'
  | 'check'
  | 'check-double'
  | 'team';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

const PATHS: Record<IconName, string> = {
  close: 'M6 6l12 12M18 6L6 18',
  send: 'M3 12l18-9-7 18-3-8-8-1z',
  chevron: 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  settings:
    'M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm7.4-2.1l1.7 1.3-2 3.5-2-.7a7.6 7.6 0 01-1.8 1l-.3 2.1h-4l-.3-2.1a7.6 7.6 0 01-1.8-1l-2 .7-2-3.5 1.7-1.3a7.5 7.5 0 010-2.1L2.9 9l2-3.5 2 .7a7.6 7.6 0 011.8-1l.3-2.1h4l.3 2.1c.6.3 1.2.6 1.8 1l2-.7 2 3.5-1.7 1.3a7.5 7.5 0 010 2.1z',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
  'check-double': 'M1 12l5 5L16 7M8 12l5 5L22 7',
  team: 'M12 12a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm-6.5-1a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm13 0a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM12 13.5c-3.3 0-6 1.8-6 4v1.5h12V17.5c0-2.2-2.7-4-6-4zm-7.5 0c-2.2 0-4 1.2-4 3V18h3.5v-.5c0-1.4.6-2.7 1.7-3.6a8 8 0 00-1.2-.4zm15 0a8 8 0 00-1.2.4c1 .9 1.7 2.2 1.7 3.6V18H23.5v-1.5c0-1.8-1.8-3-4-3z',
};

export default function Icon({ name, size = 16, color = 'currentColor' }: IconProps) {
  const d = PATHS[name];
  const isFill = name === 'send' || name === 'settings' || name === 'team';
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={isFill ? color : 'none'}
      stroke={isFill ? 'none' : color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
