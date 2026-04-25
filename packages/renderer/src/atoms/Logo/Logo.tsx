import logoSrc from '../../assets/logo-m.png';

interface LogoProps {
  size?: number;
  online?: boolean;
}

export default function Logo({ size = 56, online = true }: LogoProps) {
  const shift = Math.max(1, Math.round(size * 0.06));
  return (
    <img
      src={logoSrc}
      width={size}
      height={size}
      alt="M"
      style={{
        display: 'block',
        objectFit: 'contain',
        transform: `translateY(${shift}px)`,
        filter: online ? 'none' : 'grayscale(1)',
        opacity: online ? 1 : 0.6,
        transition: 'filter 300ms ease, opacity 300ms ease',
      }}
    />
  );
}
