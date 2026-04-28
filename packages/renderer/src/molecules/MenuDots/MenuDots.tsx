import Button from '../../atoms/Button';
import './MenuDots.css';

interface MenuDotsProps {
  onClick?: () => void;
  disabled?: boolean;
  asDragHandle?: boolean;
}

export default function MenuDots({ onClick, disabled, asDragHandle }: MenuDotsProps) {
  if (asDragHandle) {
    return (
      <div className="menu-dots menu-dots--drag" aria-hidden="true">
        <span className="menu-dots__dot" />
        <span className="menu-dots__dot" />
        <span className="menu-dots__dot" />
        <span className="menu-dots__dot" />
        <span className="menu-dots__dot" />
        <span className="menu-dots__dot" />
      </div>
    );
  }
  return <Button variant="dots" onClick={onClick} disabled={disabled} />;
}
