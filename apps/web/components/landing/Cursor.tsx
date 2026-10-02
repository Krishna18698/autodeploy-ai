'use client';

import { motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import { useEffect, useState } from 'react';

// Ring that trails the native pointer and grows over interactive elements.
// The native cursor stays visible; this is decoration, not a replacement.
export function Cursor() {
  const reduced = useReducedMotion();
  const [enabled, setEnabled] = useState(false);
  const [hover, setHover] = useState(false);
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const sx = useSpring(x, { stiffness: 500, damping: 40, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 500, damping: 40, mass: 0.4 });

  useEffect(() => {
    if (reduced || window.matchMedia('(pointer: coarse)').matches) return;
    setEnabled(true);
    const move = (e: PointerEvent) => {
      x.set(e.clientX);
      y.set(e.clientY);
      const el = e.target;
      setHover(el instanceof Element && el.closest('a, button, [data-cursor]') !== null);
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => window.removeEventListener('pointermove', move);
  }, [reduced, x, y]);

  if (!enabled) return null;
  return (
    <motion.div
      aria-hidden
      style={{ x: sx, y: sy }}
      className="pointer-events-none fixed left-0 top-0 z-50"
    >
      <motion.div
        animate={{ scale: hover ? 1.9 : 1, opacity: hover ? 0.9 : 0.55 }}
        transition={{ type: 'spring', stiffness: 300, damping: 22 }}
        className="-ml-3 -mt-3 size-6 rounded-full border border-run/80"
      />
    </motion.div>
  );
}
