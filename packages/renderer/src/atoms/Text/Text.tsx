import type { ReactNode } from 'react';
import './Text.css';

interface TextProps {
  variant?: 'title' | 'subtitle' | 'caption' | 'badge';
  children: ReactNode;
}

export default function Text({ variant = 'caption', children }: TextProps) {
  return <span className={`text text--${variant}`}>{children}</span>;
}
