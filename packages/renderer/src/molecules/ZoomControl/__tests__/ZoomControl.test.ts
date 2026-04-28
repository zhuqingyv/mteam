import { describe, it, expect } from 'bun:test';
import { zoomToPercent } from '../ZoomControl';

describe('ZoomControl zoomToPercent', () => {
  it('scales zoom to percent', () => {
    expect(zoomToPercent(1)).toBe(100);
    expect(zoomToPercent(0.25)).toBe(25);
    expect(zoomToPercent(1.5)).toBe(150);
    expect(zoomToPercent(3)).toBe(300);
  });

  it('rounds to integer', () => {
    expect(zoomToPercent(1.234)).toBe(123);
    expect(zoomToPercent(0.999)).toBe(100);
  });

  it('clamps to [0, 300]', () => {
    expect(zoomToPercent(-0.5)).toBe(0);
    expect(zoomToPercent(5)).toBe(300);
  });

  it('handles NaN / Infinity', () => {
    expect(zoomToPercent(Number.NaN)).toBe(0);
    expect(zoomToPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
