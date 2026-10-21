import { describe, it, expect, vi } from 'vitest';
import { easeOutCubic, frameValue, shouldSkipMotion } from '../useCountUp.js';

describe('useCountUp utilities', () => {
  describe('easeOutCubic', () => {
    it('returns 0 at t=0', () => {
      expect(easeOutCubic(0)).toBe(0);
    });

    it('returns 1 at t=1', () => {
      expect(easeOutCubic(1)).toBe(1);
    });

    it('returns 0.875 at t=0.5', () => {
      // 1 - (1 - 0.5)^3 = 1 - 0.125 = 0.875
      expect(easeOutCubic(0.5)).toBe(0.875);
    });

    it('is monotonically increasing', () => {
      let last = 0;
      for (let t = 0; t <= 1; t += 0.1) {
        expect(easeOutCubic(t)).toBeGreaterThanOrEqual(last);
        last = easeOutCubic(t);
      }
    });
  });

  describe('frameValue', () => {
    it('returns from when elapsed=0', () => {
      expect(frameValue(0, 100, 0, 600)).toBe(0);
    });

    it('returns to when elapsed>=duration', () => {
      expect(frameValue(0, 100, 600, 600)).toBe(100);
      expect(frameValue(0, 100, 700, 600)).toBe(100);
    });

    it('interpolates correctly at midpoint', () => {
      // at t=0.5, eased=0.875, value should be 0 + 100*0.875 = 87.5, rounded = 88
      expect(frameValue(0, 100, 300, 600)).toBe(88);
    });

    it('handles negative ranges', () => {
      // at t=0.5, eased=0.875, value should be -50 + 50*0.875 = -6.25, rounded = -6
      expect(frameValue(-50, 0, 300, 600)).toBe(-6);
    });
  });

  describe('shouldSkipMotion', () => {
    it('returns true for undefined', () => {
      expect(shouldSkipMotion(undefined)).toBe(true);
    });

    it('returns true for empty object (no matchMedia)', () => {
      expect(shouldSkipMotion({})).toBe(true);
    });

    it('returns true when matchMedia exists but prefers-reduced-motion matches', () => {
      const win = {
        matchMedia: vi.fn().mockReturnValue({ matches: true }),
        requestAnimationFrame: vi.fn(),
      };
      expect(shouldSkipMotion(win)).toBe(true);
    });

    it('returns false when matchMedia exists and prefers-reduced-motion does not match', () => {
      const win = {
        matchMedia: vi.fn().mockReturnValue({ matches: false }),
        requestAnimationFrame: vi.fn(),
      };
      expect(shouldSkipMotion(win)).toBe(false);
    });
  });
});
