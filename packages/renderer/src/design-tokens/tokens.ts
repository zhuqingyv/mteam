export const tokens = {
  color: {
    accentPrimary: '#4aa3ff',
    accentSuccess: '#23c55e',
    accentWarning: '#f5a623',
    accentDanger: '#ff5b5b',
    textPrimary: 'rgba(255,255,255,0.92)',
    textSecondary: 'rgba(255,255,255,0.62)',
    textTertiary: 'rgba(255,255,255,0.45)',
    textInverse: 'rgba(20,24,32,0.92)',
    surfaceGlassDark: 'rgba(34,36,47,0.85)',
    surfaceGlassLight: 'rgba(255,255,255,0.18)',
    surfaceOverlay: 'rgba(0,0,0,0.35)',
  },
  space: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 },
  radius: { sm: 6, md: 12, lg: 20, xl: 28, pill: 999 },
  fontSize: { xs: 11, sm: 12, md: 14, lg: 15, xl: 22 },
  duration: { fast: 120, base: 200, slow: 320 },
} as const;
