import Button from '../../atoms/Button';

interface MenuDotsProps {
  onClick?: () => void;
  disabled?: boolean;
}

export default function MenuDots({ onClick, disabled }: MenuDotsProps) {
  return <Button variant="dots" onClick={onClick} disabled={disabled} />;
}
