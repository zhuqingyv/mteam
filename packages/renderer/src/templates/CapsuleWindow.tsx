import type { ReactNode } from 'react';

interface CapsuleWindowProps {
  children: ReactNode;
}

export default function CapsuleWindow({ children }: CapsuleWindowProps) {
  return (
    <div className="w-screen h-screen p-5 box-border overflow-hidden bg-transparent">
      {children}
    </div>
  );
}
