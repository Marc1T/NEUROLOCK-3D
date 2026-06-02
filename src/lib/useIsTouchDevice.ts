import { useEffect, useState } from 'react';

/**
 * Detect whether the device has a touch-primary input.
 * Returns `true` for phones, tablets, and 2-in-1 laptops in tablet mode.
 *
 * Combines:
 *  - the `(pointer: coarse)` media query (most reliable on modern browsers)
 *  - a fallback to `navigator.maxTouchPoints > 0` (catches older mobile browsers)
 */
export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState<boolean>(() => detect());

  useEffect(() => {
    // Re-evaluate on resize / orientation change so a Surface-style 2-in-1
    // toggles correctly between tablet and laptop modes.
    const mq = window.matchMedia('(pointer: coarse)');
    const handler = () => setIsTouch(detect());
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);
    window.addEventListener('orientationchange', handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
      window.removeEventListener('orientationchange', handler);
    };
  }, []);

  return isTouch;
}

function detect(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
  if ((navigator as any).maxTouchPoints > 0) return true;
  if ('ontouchstart' in window) return true;
  return false;
}
