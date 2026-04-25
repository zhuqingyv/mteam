import Button from '../../atoms/Button';

interface MenuDotsProps {
  onClick?: () => void;
}

export default function MenuDots({ onClick }: MenuDotsProps) {
  return <Button variant="dots" onClick={onClick} />;
}
