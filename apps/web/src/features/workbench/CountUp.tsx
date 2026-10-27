import { useEffect, useRef, useState } from 'react';

/**
 * CountUp 数字滚动：首次挂载时数字从 0 缓动滚到目标值；
 * 目标值后续变化时直接跟随（避免删除项目后重新滚动的怪异感）；
 * prefers-reduced-motion 时不做动画。
 */
export function CountUp({ value, duration = 900 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(value);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (value <= 0) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setDisplay(value);
        return;
      }
      const start = performance.now();
      let frame = 0;
      const tick = (now: number) => {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        setDisplay(Math.round(value * eased));
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    setDisplay(value);
  }, [value, duration]);

  return <>{display}</>;
}
