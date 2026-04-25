import './DragHandle.css';

interface DragHandleProps {
  visible?: boolean;
}

export default function DragHandle({ visible = true }: DragHandleProps) {
  const cls = ['drag-handle'];
  if (!visible) cls.push('drag-handle--hidden');
  return (
    <div className={cls.join(' ')}>
      <div className="drag-handle__pill" />
    </div>
  );
}
