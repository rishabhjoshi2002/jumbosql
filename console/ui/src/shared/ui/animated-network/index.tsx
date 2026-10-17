import { FC, useEffect, useRef } from 'react';
import { Box } from '@mui/material';

type Dot = { x: number; y: number; vx: number; vy: number; r: number; gold: boolean };

/**
 * A living network behind the sign-in page: nodes drift, nearby ones link up, and small data packets travel along
 * the links (servers talking to each other). It follows the mouse a little, pauses when the tab is hidden, and is
 * still (one frame) for people who ask for reduced motion.
 */
const AnimatedNetwork: FC<{ density?: number }> = ({ density = 1 }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let dots: Dot[] = [];
    let packets: { a: number; b: number; t: number; speed: number }[] = [];
    const mouse = { x: -9999, y: -9999 };
    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(140, (w * h) / 11000) * density);
      dots = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.6 + 0.8,
        gold: Math.random() < 0.14,
      }));
      packets = [];
    };
    const link = 130;

    const frame = () => {
      ctx.clearRect(0, 0, w, h);
      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < 0 || d.x > w) d.vx *= -1;
        if (d.y < 0 || d.y > h) d.vy *= -1;
        // a gentle pull towards the mouse
        const mx = mouse.x - d.x;
        const my = mouse.y - d.y;
        const md = Math.hypot(mx, my);
        if (md < 180 && md > 1) {
          d.x += (mx / md) * 0.25;
          d.y += (my / md) * 0.25;
        }
      }
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const a = dots[i];
          const b = dots[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < link) {
            ctx.strokeStyle = `rgba(86, 160, 255, ${0.22 * (1 - dist / link)})`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            if (!still && packets.length < 26 && Math.random() < 0.0009) {
              packets.push({ a: i, b: j, t: 0, speed: 0.008 + Math.random() * 0.012 });
            }
          }
        }
      }
      for (const d of dots) {
        ctx.beginPath();
        ctx.fillStyle = d.gold ? 'rgba(244, 179, 33, 0.9)' : 'rgba(140, 200, 255, 0.85)';
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      packets = packets.filter((p) => {
        const a = dots[p.a];
        const b = dots[p.b];
        if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > link) return false;
        p.t += p.speed;
        const x = a.x + (b.x - a.x) * p.t;
        const y = a.y + (b.y - a.y) * p.t;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 7);
        g.addColorStop(0, 'rgba(255, 214, 102, 0.95)');
        g.addColorStop(1, 'rgba(255, 214, 102, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        return p.t < 1;
      });
      if (!still && !document.hidden) raf = requestAnimationFrame(frame);
    };

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    };
    const onLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };
    const onVisible = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    resize();
    frame();
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseout', onLeave);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseout', onLeave);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [density]);

  return (
    <Box
      component="canvas"
      ref={ref}
      aria-hidden
      sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  );
};

export default AnimatedNetwork;
