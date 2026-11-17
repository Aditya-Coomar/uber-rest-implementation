'use client';

import { useId, useRef, useState } from 'react';

/** Validated categorical slots (light surface), assigned in fixed order. */
export const SERIES = { 1: '#2a78d6', 2: '#eb6834', 3: '#1baf7a' } as const;
export const REFERENCE = '#9aa0a8';

export interface Series {
  key: string;
  name: string;
  color: string;
  values: Array<number | null>;
  dashed?: boolean;
}

interface LineChartProps {
  title: string;
  description: string;
  x: number[];
  series: Series[];
  format?: (v: number) => string;
  height?: number;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
};

/**
 * Small time-series chart: one y-axis, 2px lines, recessive grid, legend plus
 * direct end labels, and a crosshair tooltip on hover/focus.
 */
export default function LineChart({ title, description, x, series, format = (v) => String(Math.round(v)), height = 170 }: LineChartProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 560;
  const m = { top: 10, right: 64, bottom: 22, left: 40 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const yMax = niceMax(Math.max(1, ...all));
  const xMax = Math.max(1, x[x.length - 1] ?? 1);
  const sx = (v: number) => m.left + (v / xMax) * w;
  const sy = (v: number) => m.top + h - (v / yMax) * h;
  const ticks = [0, yMax / 2, yMax];

  const pathFor = (values: Array<number | null>) => {
    let d = '';
    let pen = false;
    // Sampled series can miss a second; connect across gaps rather than breaking the line.
    values.forEach((v, i) => {
      if (v === null || x[i] === undefined) return;
      d += `${pen ? 'L' : 'M'}${sx(x[i]).toFixed(1)},${sy(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const t = ((px - m.left) / w) * xMax;
    let best = 0;
    x.forEach((xv, i) => {
      if (Math.abs(xv - t) < Math.abs(x[best] - t)) best = i;
    });
    setHover(x.length ? best : null);
  };

  const lastIndex = (values: Array<number | null>) => {
    for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] !== null) return i;
    return -1;
  };

  // Direct end labels, nudged apart so they never collide.
  const ends = series
    .map((s) => ({ s, i: lastIndex(s.values) }))
    .filter((e) => e.i >= 0)
    .map((e) => ({ ...e, y: sy(e.s.values[e.i] as number) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k += 1) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;

  return (
    <figure className="flex flex-col gap-2" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`}>
      <figcaption>
        <p id={`${id}-t`} className="text-[15px] font-semibold text-ink">
          {title}
        </p>
        <p id={`${id}-d`} className="text-[13px] text-muted">
          {description}
        </p>
      </figcaption>
      {series.length >= 2 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <svg width="14" height="4" aria-hidden>
                <line x1="0" y1="2" x2="14" y2="2" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '3 2' : undefined} />
              </svg>
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div ref={box} className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full overflow-visible" role="presentation">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={m.left + w} y1={sy(t)} y2={sy(t)} stroke="#e4e6df" strokeWidth={1} />
              <text x={m.left - 6} y={sy(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
                {format(t)}
              </text>
            </g>
          ))}
          <text x={m.left} y={height - 4} fontSize={11} fill="var(--muted)">
            0s
          </text>
          <text x={m.left + w} y={height - 4} textAnchor="end" fontSize={11} fill="var(--muted)">
            {Math.round(xMax)}s
          </text>
          {series.map((s) => (
            <path key={s.key} d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '5 4' : undefined} />
          ))}
          {ends.map((e) => (
            <text key={e.s.key} x={sx(x[e.i]) + 6} y={e.y + 4} fontSize={11.5} fill="var(--ink-2)" fontWeight={500}>
              {format(e.s.values[e.i] as number)} {series.length > 1 ? e.s.name.split(' ')[0].toLowerCase() : ''}
            </text>
          ))}
          {hover !== null && (
            <g>
              <line x1={sx(x[hover])} x2={sx(x[hover])} y1={m.top} y2={m.top + h} stroke="var(--ink-2)" strokeWidth={1} />
              {series.map((s) =>
                s.values[hover] !== null && s.values[hover] !== undefined ? (
                  <circle key={s.key} cx={sx(x[hover])} cy={sy(s.values[hover] as number)} r={4.5} fill={s.color} stroke="#fff" strokeWidth={2} />
                ) : null,
              )}
            </g>
          )}
          <rect
            x={m.left}
            y={m.top}
            width={w}
            height={h}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            tabIndex={0}
            onFocus={() => setHover(x.length - 1)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setHover((v) => Math.max(0, (v ?? 0) - 1));
              if (e.key === 'ArrowRight') setHover((v) => Math.min(x.length - 1, (v ?? 0) + 1));
            }}
            aria-label={`${title}: use arrow keys to inspect values`}
          />
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg bg-ink px-2.5 py-1.5 text-[12px] text-white shadow-lg"
            style={{ left: `${(sx(x[hover]) / width) * 100}%`, transform: sx(x[hover]) > width * 0.6 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)' }}
          >
            <p className="font-semibold">{Math.round(x[hover])}s</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.name}: {s.values[hover] === null || s.values[hover] === undefined ? '—' : format(s.values[hover] as number)}
              </p>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
