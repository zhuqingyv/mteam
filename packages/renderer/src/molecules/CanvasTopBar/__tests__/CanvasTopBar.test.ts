import { describe, it, expect } from 'bun:test';
import { formatZoomPercent } from '../CanvasTopBar';

describe('CanvasTopBar formatZoomPercent', () => {
  it('rounds to integer', () => {
    expect(formatZoomPercent(99.4)).toBe(99);
    expect(formatZoomPercent(99.6)).toBe(100);
  });

  it('clamps to [0, 300]', () => {
    expect(formatZoomPercent(-10)).toBe(0);
    expect(formatZoomPercent(500)).toBe(300);
    expect(formatZoomPercent(0)).toBe(0);
    expect(formatZoomPercent(300)).toBe(300);
  });

  it('handles NaN / Infinity', () => {
    expect(formatZoomPercent(Number.NaN)).toBe(0);
    expect(formatZoomPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
