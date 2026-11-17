'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { CANVAS, Pt, project, toPath } from '@/lib/geo';
import { PLACES } from '@/lib/places';

export interface MapMarker {
  lat: number;
  lng: number;
}

export interface CityMapProps {
  /** Points the camera keeps in view. */
  focus: MapMarker[];
  pickup?: MapMarker | null;
  destination?: MapMarker | null;
  /** Route polyline in canvas units. */
  route?: Pt[] | null;
  /** Portion of the route already travelled (drawn muted). */
  progress?: number;
  car?: { p: Pt; heading: number } | null;
  nearby?: MapMarker[];
  searching?: boolean;
  /** Screen space covered by the booking sheet, so the camera frames around it. */
  insetLeft: number;
  insetBottom: number;
  /** Accessible summary of what the map shows. */
  label: string;
}

interface Camera {
  cx: number;
  cy: number;
  s: number;
}

function fitCamera(points: Pt[], width: number, height: number, inset: { left: number; bottom: number }): Camera {
  const availW = Math.max(200, width - inset.left - 48);
  const availH = Math.max(200, height - inset.bottom - 96);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const pad = 60;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const w = Math.max(maxX - minX, 360);
  const h = Math.max(maxY - minY, 360);
  const s = Math.min(availW / w, availH / h, 4.5);
  // Centre of the bbox lands at the centre of the uncovered area.
  const screenCx = inset.left + 24 + availW / 2;
  const screenCy = 72 + availH / 2;
  return { cx: (minX + maxX) / 2 - (screenCx - width / 2) / s, cy: (minY + maxY) / 2 - (screenCy - height / 2) / s, s };
}

/** Static city artwork: water, parks, streets. Drawn once. */
const CityArt = memo(function CityArt() {
  const p = (lat: number, lng: number) => project(lat, lng);
  const minor: string[] = [];
  for (let v = 0; v <= CANVAS; v += 34) {
    minor.push(`M${v},0 L${v},${CANVAS}`, `M0,${v} L${CANVAS},${v}`);
  }
  const old = p(12.965, 77.577);
  const oldLanes: string[] = [];
  for (let v = -140; v <= 140; v += 22) oldLanes.push(`M${old.x - 150},${old.y + v} L${old.x + 150},${old.y + v}`, `M${old.x + v},${old.y - 150} L${old.x + v},${old.y + 150}`);
  const c = p(12.9716, 77.5946);
  const radials = [
    [p(13.02, 77.58), c, p(12.925, 77.61)],
    [p(12.99, 77.55), c, p(12.94, 77.66)],
    [p(13.02, 77.635), p(12.9817, 77.6195), c],
    [p(12.925, 77.565), p(12.955, 77.585), c],
    [p(12.9779, 77.55), p(12.9779, 77.5713), p(12.976, 77.6), p(12.985, 77.66)],
    [p(12.9352, 77.6245), p(12.9592, 77.6448), p(12.99, 77.66)],
  ].map((pts) => toPath(pts));
  const ring = `M${c.x + 330},${c.y} A330,300 0 1,1 ${c.x - 330},${c.y} A330,300 0 1,1 ${c.x + 330},${c.y}`;
  const highway = toPath([p(13.02, 77.596), p(13.0101, 77.5911), p(12.9952, 77.5735), p(12.925, 77.555)]);
  const lake = p(12.9835, 77.623);
  const river = `M0,${p(12.951, 77.55).y} C${p(12.958, 77.58).x},${p(12.962, 77.58).y} ${p(12.95, 77.6).x},${p(12.952, 77.6).y} ${p(12.9551, 77.6005).x},${p(12.9551, 77.6005).y} S${p(12.94, 77.64).x},${p(12.945, 77.64).y} ${CANVAS},${p(12.936, 77.66).y}`;
  const park = [p(12.9805, 77.5905), p(12.982, 77.6035), p(12.9715, 77.6025), p(12.9695, 77.5925)];
  const campus = [p(13.006, 77.578), p(13.007, 77.592), p(12.996, 77.593), p(12.995, 77.579)];
  return (
    <g>
      <rect x={-2000} y={-2000} width={CANVAS + 4000} height={CANVAS + 4000} fill="var(--land)" />
      <path d={minor.join(' ')} stroke="#f2f3ee" strokeWidth={5} vectorEffect="non-scaling-stroke" />
      <path d={oldLanes.join(' ')} stroke="#f2f3ee" strokeWidth={3} transform={`rotate(24 ${old.x} ${old.y})`} vectorEffect="non-scaling-stroke" />
      <path d={`${toPath(park)} Z`} fill="var(--park)" />
      <path d={`${toPath(campus)} Z`} fill="var(--park)" />
      <circle cx={p(12.9592, 77.6448).x - 30} cy={p(12.9592, 77.6448).y + 40} r={26} fill="var(--park)" />
      <path d={river} stroke="var(--water)" strokeWidth={14} fill="none" strokeLinecap="round" />
      <ellipse cx={lake.x} cy={lake.y} rx={32} ry={22} fill="var(--water)" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d={radials.join(' ')} stroke="#d6d9cf" strokeWidth={11} vectorEffect="non-scaling-stroke" />
        <path d={ring} stroke="#d6d9cf" strokeWidth={11} vectorEffect="non-scaling-stroke" />
        <path d={radials.join(' ')} stroke="#ffffff" strokeWidth={8} vectorEffect="non-scaling-stroke" />
        <path d={ring} stroke="#ffffff" strokeWidth={8} vectorEffect="non-scaling-stroke" />
        <path d={highway} stroke="#e5cf98" strokeWidth={13} vectorEffect="non-scaling-stroke" />
        <path d={highway} stroke="#f6e3b0" strokeWidth={9} vectorEffect="non-scaling-stroke" />
      </g>
    </g>
  );
});

function CarIcon({ x, y, heading, mine }: { x: number; y: number; heading: number; mine?: boolean }) {
  const scale = mine ? 1.25 : 0.85;
  return (
    <g transform={`translate(${x} ${y}) rotate(${heading}) scale(${scale})`}>
      <rect x={-13} y={-7.5} width={26} height={15} rx={5} fill={mine ? 'var(--amber)' : '#3b4048'} stroke="#ffffff" strokeWidth={2} />
      <rect x={1} y={-5.5} width={6} height={11} rx={2} fill={mine ? '#7a5300' : '#9aa0a8'} opacity={0.75} />
      <rect x={-9} y={-5.5} width={4} height={11} rx={1.5} fill={mine ? '#7a5300' : '#9aa0a8'} opacity={0.5} />
    </g>
  );
}

export default function CityMap(props: CityMapProps) {
  const { focus, pickup, destination, route, progress = 0, car, nearby = [], searching, insetLeft, insetBottom, label } = props;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [camera, setCamera] = useState<Camera>({ cx: CANVAS / 2, cy: CANVAS / 2, s: 1 });
  const cameraRef = useRef(camera);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Tween the camera toward the framing of the current focus.
  const focusKey = focus.map((f) => `${f.lat.toFixed(4)},${f.lng.toFixed(4)}`).join('|');
  useEffect(() => {
    const pts = focusKey ? focusKey.split('|').map((s) => { const [lat, lng] = s.split(',').map(Number); return project(lat, lng); }) : [{ x: CANVAS / 2, y: CANVAS / 2 }];
    const target = fitCamera(pts, size.w, size.h, { left: insetLeft, bottom: insetBottom });
    const from = cameraRef.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 0 : 700;
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = duration === 0 ? 1 : Math.min(1, (now - started) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      const next = { cx: from.cx + (target.cx - from.cx) * e, cy: from.cy + (target.cy - from.cy) * e, s: from.s * Math.pow(target.s / from.s, e) };
      cameraRef.current = next;
      setCamera(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [focusKey, size.w, size.h, insetLeft, insetBottom]);

  const toScreen = (pt: Pt) => ({ x: (pt.x - camera.cx) * camera.s + size.w / 2, y: (pt.y - camera.cy) * camera.s + size.h / 2 });
  const screenRoute = route?.map(toScreen) ?? null;
  const pickupPt = pickup ? toScreen(project(pickup.lat, pickup.lng)) : null;
  const destPt = destination ? toScreen(project(destination.lat, destination.lng)) : null;
  const carPt = car ? toScreen(car.p) : null;

  // Split the route into travelled / remaining at the car's progress.
  let travelled: string | null = null;
  let remaining: string | null = null;
  if (screenRoute) {
    if (progress > 0 && car && carPt) {
      const total = screenRoute.reduce((acc, p, i) => (i ? acc + Math.hypot(p.x - screenRoute[i - 1].x, p.y - screenRoute[i - 1].y) : 0), 0);
      let walked = 0;
      const done: Pt[] = [screenRoute[0]];
      let i = 1;
      for (; i < screenRoute.length; i += 1) {
        const seg = Math.hypot(screenRoute[i].x - screenRoute[i - 1].x, screenRoute[i].y - screenRoute[i - 1].y);
        if (walked + seg >= progress * total) break;
        walked += seg;
        done.push(screenRoute[i]);
      }
      done.push(carPt);
      travelled = toPath(done);
      remaining = toPath([carPt, ...screenRoute.slice(i)]);
    } else {
      remaining = toPath(screenRoute);
    }
  }

  const labels = PLACES.map((pl) => ({ pl, pt: toScreen(project(pl.lat, pl.lng)) })).filter(
    ({ pt }) => pt.x > 0 && pt.y > 0 && pt.x < size.w && pt.y < size.h,
  );

  return (
    <div ref={box} className="absolute inset-0 overflow-hidden bg-land" role="img" aria-label={label}>
      <svg width={size.w} height={size.h} className="block select-none">
        <g transform={`translate(${size.w / 2} ${size.h / 2}) scale(${camera.s}) translate(${-camera.cx} ${-camera.cy})`}>
          <CityArt />
        </g>
        {camera.s > 1.6 &&
          labels.map(({ pl, pt }) => (
            <text key={pl.id} x={pt.x} y={pt.y - 12} textAnchor="middle" fontSize={11.5} fill="#7b8088" fontWeight={500} style={{ paintOrder: 'stroke' }} stroke="var(--land)" strokeWidth={3}>
              {pl.label}
            </text>
          ))}
        {nearby.map((d, i) => {
          const pt = toScreen(project(d.lat, d.lng));
          return <CarIcon key={i} x={pt.x} y={pt.y} heading={(i * 67) % 360} />;
        })}
        {travelled && <path d={travelled} fill="none" stroke="#9aa0a8" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />}
        {remaining && (
          <>
            <path d={remaining} fill="none" stroke="var(--ink)" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
            <path d={remaining} fill="none" stroke="var(--amber)" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {pickupPt && (
          <g transform={`translate(${pickupPt.x} ${pickupPt.y})`}>
            {searching && (
              <>
                <circle r={22} fill="var(--amber)" className="kerb-ping" />
                <circle r={22} fill="var(--amber)" className="kerb-ping" style={{ animationDelay: '0.9s' }} />
              </>
            )}
            <circle r={9} fill="var(--ink)" stroke="#fff" strokeWidth={3} />
            <circle r={3} fill="#fff" />
          </g>
        )}
        {destPt && (
          <g transform={`translate(${destPt.x} ${destPt.y})`}>
            <rect x={-8} y={-8} width={16} height={16} fill="var(--ink)" stroke="#fff" strokeWidth={3} />
            <rect x={-2.5} y={-2.5} width={5} height={5} fill="#fff" />
          </g>
        )}
        {carPt && car && <CarIcon x={carPt.x} y={carPt.y} heading={car.heading} mine />}
      </svg>
    </div>
  );
}
