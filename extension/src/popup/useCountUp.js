import { useState, useEffect, useRef, useLayoutEffect } from 'react';

/**
 * Ease-out cubic curve for count-up animation.
 * @param {number} t - Progress from 0 to 1
 * @returns {number} Eased value from 0 to 1
 */
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Calculate the current value for a frame.
 * @param {number} from - Starting value
 * @param {number} to - Target value
 * @param {number} elapsed - Elapsed time in ms
 * @param {number} duration - Total duration in ms
 * @returns {number} Current interpolated value
 */
export function frameValue(from, to, elapsed, duration) {
  const progress = Math.min(elapsed / duration, 1);
  const eased = easeOutCubic(progress);
  return Math.round(from + (to - from) * eased);
}

/**
 * Check if motion should be skipped.
 * @param {Window|undefined} win - Window object to check
 * @returns {boolean} True if motion should be skipped
 */
export function shouldSkipMotion(win) {
  if (!win) return true;
  if (typeof win.matchMedia !== 'function') return true;
  if (typeof win.requestAnimationFrame !== 'function') return true;
  return win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Count-up hook that animates an integer from 0 to target.
 * @param {number} target - Target number to count up to
 * @param {{ duration?: number }} options - Options object
 * @returns {number} The current value
 */
export function useCountUp(target, { duration = 600 } = {}) {
  const skip = shouldSkipMotion(typeof window !== 'undefined' ? window : undefined);

  const [value, setValue] = useState(skip ? target : 0);
  const rafRef = useRef(null);
  const startRef = useRef(null);
  const fromRef = useRef(0);
  const targetRef = useRef(target);
  const durationRef = useRef(duration);
  const valueRef = useRef(skip ? target : 0);

  // Keep refs in sync using useLayoutEffect (runs after render but before paint)
  useLayoutEffect(() => {
    targetRef.current = target;
    durationRef.current = duration;
    valueRef.current = value;
  }, [target, duration, value]);

  useEffect(() => {
    if (skip) return;

    const animate = (timestamp) => {
      if (!startRef.current) startRef.current = timestamp;
      const elapsed = timestamp - startRef.current;
      const newValue = frameValue(fromRef.current, targetRef.current, elapsed, durationRef.current);
      setValue(newValue);

      if (elapsed < durationRef.current) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    // Animate from current value to new target
    fromRef.current = valueRef.current;
    startRef.current = null;
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [target, duration, skip]);

  // No animation: always the live target, never a value frozen at first render.
  return skip ? target : value;
}
