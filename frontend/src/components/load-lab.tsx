'use client';

import { useEffect, useState } from 'react';
import { ApiError, Simulation, SimulationConfig, simApi } from '@/lib/api';
import LineChart, { REFERENCE, SERIES } from './line-chart';

const PRESETS: Array<{ name: string; detail: string; config: SimulationConfig }> = [
  { name: 'Quiet afternoon', detail: '3 requests/s · 60 cars', config: { ratePerSecond: 3, durationSeconds: 30, fleetSize: 60, cancelRate: 0.1, tripSeconds: 4, retryDeclined: true } },
  { name: 'Rush hour', detail: '15 requests/s · 120 cars', config: { ratePerSecond: 15, durationSeconds: 45, fleetSize: 120, cancelRate: 0.1, tripSeconds: 4, retryDeclined: true } },
  { name: 'Stadium exit', detail: '40 requests/s · 80 cars', config: { ratePerSecond: 40, durationSeconds: 30, fleetSize: 80, cancelRate: 0.05, tripSeconds: 5, retryDeclined: true } },
];

const FIELDS: Array<{ key: keyof Omit<SimulationConfig, 'retryDeclined'>; label: string; min: number; max: number; step: number; show: (v: number) => string; help: string }> = [
  { key: 'ratePerSecond', label: 'Ride requests per second', min: 1, max: 50, step: 1, show: (v) => `${v}/s`, help: 'Arrivals keep coming at this rate whether or not earlier requests have finished.' },
  { key: 'durationSeconds', label: 'Duration', min: 5, max: 180, step: 5, show: (v) => `${v}s`, help: 'How long new requests keep arriving. In-flight trips then finish.' },
  { key: 'fleetSize', label: 'Simulated cars on the road', min: 0, max: 300, step: 10, show: (v) => String(v), help: 'Added for the run, removed afterwards. The three regular drivers stay.' },
  { key: 'tripSeconds', label: 'Average trip length', min: 1, max: 15, step: 1, show: (v) => `${v}s`, help: 'How long a simulated rider keeps the car before the trip ends.' },
  { key: 'cancelRate', label: 'Riders who cancel', min: 0, max: 0.5, step: 0.05, show: (v) => `${Math.round(v * 100)}%`, help: 'Share of assigned rides cancelled instead of completed.' },
];

const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(v < 10 ? 1 : 0)}%`);

/** Plain-language reading of a finished (or running) run. */
function findings(s: Simulation): string[] {
  const out: string[] = [];
  const t = s.totals;
  const peakBusy = Math.max(0, ...s.timeline.map((p) => (p.totalDrivers ? p.busyDrivers! / p.totalDrivers : 0)));
  const peakJobs = Math.max(0, ...s.timeline.map((p) => p.jobsPending ?? 0));
  const peakQueue = Math.max(0, ...s.timeline.map((p) => p.queueDepth ?? 0));
  if ((s.rates.noDriverPct ?? 0) >= 10) {
    out.push(`Supply ran out: ${pct(s.rates.noDriverPct)} of requests found no free car (fleet peaked at ${Math.round(peakBusy * 100)}% busy). Riders got a fast, definite answer instead of waiting.`);
  } else if (t.requested > 0) {
    out.push(`Supply kept up: ${pct(s.rates.assignedPct)} of requests were matched; the fleet peaked at ${Math.round(peakBusy * 100)}% busy.`);
  }
  if (t.unavailable > 0) {
    out.push(`${t.unavailable} bookings exceeded the 2.5 s matching budget and returned “still matching”; the worker settled them in the background (${t.recovered} ended up with a driver).`);
  }
  if ((s.latencyMs.booking.p95 ?? 0) > 1000) {
    out.push(`Booking slowed under contention (p95 ${ms(s.latencyMs.booking.p95)}): many riders competed for the same nearest cars, so claims retried.`);
  } else if (s.latencyMs.booking.count > 0) {
    out.push(`Booking stayed fast (p95 ${ms(s.latencyMs.booking.p95)}).`);
  }
  if (t.completed > 0) {
    out.push(
      `Ending a trip stayed quick (p95 ${ms(s.latencyMs.complete.p95)}) because payment, driver release and analytics run afterwards as durable jobs; payments settled ${ms(s.latencyMs.paymentSettle.p50)} after the trip ended (median).`,
    );
  }
  if (peakJobs > 50 || peakQueue > 20) {
    out.push(`Background work queued up — up to ${peakJobs} pending jobs and ${peakQueue} event messages — then drained without losing any.`);
  }
  const last = [...s.timeline].reverse().find((p) => p.projectedCompleted !== null);
  if (last && last.expectedCompleted !== null) {
    out.push(
      last.projectedCompleted === last.expectedCompleted
        ? `Analytics caught up exactly: ${last.projectedCompleted} completed trips counted, each once.`
        : `Analytics is ${Math.max(0, last.expectedCompleted - (last.projectedCompleted ?? 0))} trips behind and still catching up.`,
    );
  }
  if (t.paid + t.declined > 0) {
    out.push(`Banks approved ${pct(s.rates.approvalPct)} of charges; ${t.retried} riders paid again with another card after a decline and ${t.paidAfterRetry} of those went through.`);
  }
  return out;
}

export default function LoadLab() {
  const [config, setConfig] = useState<SimulationConfig>(PRESETS[1].config);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const active = sim !== null && ['preparing', 'running', 'draining'].includes(sim.status);

  // Fetch the latest run; poll every second while one is active.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const s = await simApi.current(controller.signal);
        if (controller.signal.aborted) return;
        setSim(s);
        setError(null);
        if (s && ['preparing', 'running', 'draining'].includes(s.status)) timer = setTimeout(load, 1_000);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : 'The load simulator is unavailable.');
        timer = setTimeout(load, 3_000);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, starting]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setSim(await simApi.start(config));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t start the simulation.');
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    try {
      setSim(await simApi.stop());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t stop the simulation.');
    }
  };

  const tl = sim?.timeline ?? [];
  const x = tl.map((p) => p.t);
  const statusText: Record<Simulation['status'], string> = {
    preparing: 'Putting simulated cars on the road…',
    running: 'Sending ride requests',
    draining: 'No new requests — letting trips in progress finish',
    finished: 'Finished',
    stopped: 'Stopped early',
    failed: 'Failed',
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 pb-16 pt-24 lg:px-8">
      <header className="max-w-3xl">
        <h1 className="font-display text-[44px] font-semibold leading-[0.95] lg:text-[60px]">What happens when the whole city books at once?</h1>
        <p className="mt-4 text-[16px] leading-7 text-ink-2">
          Send a stream of simulated riders through the real system. Each one requests a ride, keeps the car for a while, ends the trip (or cancels),
          and pays — retrying with another card if the bank declines. Watch where it bends: driver supply, matching, background jobs, and analytics.
        </p>
      </header>

      <section className="grid gap-8 lg:grid-cols-[360px_1fr]" aria-label="Simulation settings">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                disabled={active}
                onClick={() => setConfig(p.config)}
                className={`flex items-baseline justify-between rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60 ${
                  JSON.stringify(config) === JSON.stringify(p.config) ? 'border-ink bg-white' : 'border-line hover:border-ink-2'
                }`}
              >
                <span className="text-[15px] font-semibold">{p.name}</span>
                <span className="text-[13px] text-muted">{p.detail}</span>
              </button>
            ))}
          </div>
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between text-[14px] font-medium">
                {f.label}
                <span className="font-display text-[18px] font-semibold tabular-nums">{f.show(config[f.key])}</span>
              </span>
              <input
                type="range"
                min={f.min}
                max={f.max}
                step={f.step}
                value={config[f.key]}
                disabled={active}
                onChange={(e) => setConfig({ ...config, [f.key]: Number(e.target.value) })}
                className="accent-[var(--ink)]"
              />
              <span className="text-[12.5px] text-muted">{f.help}</span>
            </label>
          ))}
          <label className="flex items-center gap-2.5 text-[14px]">
            <input type="checkbox" checked={config.retryDeclined} disabled={active} onChange={(e) => setConfig({ ...config, retryDeclined: e.target.checked })} className="h-4 w-4 accent-[var(--ink)]" />
            Riders retry declined payments with another card
          </label>
          <p className="text-[13px] text-muted">
            About {Math.round(config.ratePerSecond * config.durationSeconds)} ride requests in total.
          </p>
          {active ? (
            <button type="button" onClick={stop} className="h-13 rounded-2xl border-2 border-ink py-3 text-[16px] font-semibold">
              Stop sending requests
            </button>
          ) : (
            <button type="button" onClick={start} disabled={starting} className="h-13 rounded-2xl bg-ink py-3.5 text-[16px] font-semibold text-white disabled:opacity-60">
              {starting ? 'Starting…' : 'Start simulation'}
            </button>
          )}
          {error && (
            <p role="alert" className="rounded-xl bg-bad-wash px-3.5 py-2.5 text-[14px] text-bad">
              {error}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-8">
          {!sim ? (
            <div className="grid min-h-[320px] place-items-center rounded-3xl border border-dashed border-line p-10 text-center">
              <p className="max-w-sm text-[15px] text-ink-2">Pick a scenario and start a run. Live results appear here, second by second.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-3" aria-live="polite">
                <p className="text-[15px]">
                  <span className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${active ? 'animate-pulse bg-amber' : sim.status === 'failed' ? 'bg-bad' : 'bg-good'}`} aria-hidden />
                  <span className="font-semibold">{statusText[sim.status]}</span>
                  <span className="text-muted"> · {Math.round(sim.elapsedSeconds)}s · {sim.inFlight} riders mid-trip</span>
                </p>
                <p className="text-[13px] text-muted">
                  {sim.config.ratePerSecond}/s for {sim.config.durationSeconds}s · {sim.config.fleetSize} simulated cars
                </p>
              </div>
              {sim.error && <p className="rounded-xl bg-bad-wash px-3.5 py-2.5 text-[14px] text-bad">{sim.error}</p>}

              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-6 sm:grid-cols-4">
                {[
                  ['Requests sent', String(sim.totals.requested), `${sim.rates.achievedRequestsPerSecond}/s achieved`],
                  ['Matched with a driver', pct(sim.rates.assignedPct), `${sim.totals.assigned} rides`],
                  ['No car available', pct(sim.rates.noDriverPct), `${sim.totals.noDriver} riders`],
                  ['Failed or delayed', pct(sim.rates.failedPct), `${sim.totals.unavailable} still matching · ${sim.totals.errors} errors`],
                  ['Booking time, p95', ms(sim.latencyMs.booking.p95), `median ${ms(sim.latencyMs.booking.p50)}`],
                  ['End-trip time, p95', ms(sim.latencyMs.complete.p95), `${sim.totals.completed} trips ended`],
                  ['Payment settled after', ms(sim.latencyMs.paymentSettle.p50), `median · p95 ${ms(sim.latencyMs.paymentSettle.p95)}`],
                  ['Bank approvals', pct(sim.rates.approvalPct), `${sim.totals.paid + sim.totals.paidAfterRetry} paid · ${sim.totals.declined} declined`],
                ].map(([label, value, sub]) => (
                  <div key={label}>
                    <dt className="text-[13px] text-muted">{label}</dt>
                    <dd className="font-display text-[30px] font-semibold leading-tight tabular-nums">{value}</dd>
                    <dd className="text-[12.5px] text-ink-2">{sub}</dd>
                  </div>
                ))}
              </dl>

              {tl.length > 1 && (
                <div className="grid gap-x-10 gap-y-10 xl:grid-cols-2">
                  <LineChart
                    title="Requests per second"
                    description="What riders asked for, and what the system could serve."
                    x={x}
                    series={[
                      { key: 'req', name: 'Requested', color: SERIES[1], values: tl.map((p) => p.requested) },
                      { key: 'nod', name: 'No car', color: SERIES[2], values: tl.map((p) => p.noDriver) },
                      { key: 'asg', name: 'Matched', color: SERIES[3], values: tl.map((p) => p.assigned) },
                    ]}
                  />
                  <LineChart
                    title="Booking time"
                    description="How long riders waited for an answer, per second of the run."
                    x={x}
                    format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`)}
                    series={[
                      { key: 'p50', name: 'Median', color: SERIES[1], values: tl.map((p) => p.bookingP50) },
                      { key: 'p95', name: 'Slowest 5%', color: SERIES[2], values: tl.map((p) => p.bookingP95) },
                    ]}
                  />
                  <LineChart
                    title="Cars on a trip"
                    description="Busy drivers against the size of the fleet. When the lines meet, new riders find no car."
                    x={x}
                    series={[
                      { key: 'busy', name: 'Busy cars', color: SERIES[1], values: tl.map((p) => p.busyDrivers) },
                      { key: 'total', name: 'Fleet size', color: REFERENCE, values: tl.map((p) => p.totalDrivers), dashed: true },
                    ]}
                  />
                  <LineChart
                    title="Background work waiting"
                    description="Durable jobs (payments, driver release, event publishing) and event messages not yet processed."
                    x={x}
                    series={[
                      { key: 'jobs', name: 'Pending jobs', color: SERIES[1], values: tl.map((p) => p.jobsPending) },
                      { key: 'queue', name: 'Queued events', color: SERIES[2], values: tl.map((p) => p.queueDepth) },
                    ]}
                  />
                  <LineChart
                    title="Analytics catching up"
                    description="Trips riders finished versus trips the analytics pipeline has counted. The gap is the pipeline’s lag."
                    x={x}
                    series={[
                      { key: 'exp', name: 'Finished', color: SERIES[1], values: tl.map((p) => p.expectedCompleted) },
                      { key: 'proj', name: 'Counted', color: SERIES[3], values: tl.map((p) => p.projectedCompleted) },
                    ]}
                  />
                  <LineChart
                    title="Trips ending and payments"
                    description="Trips ended each second, and payments approved."
                    x={x}
                    series={[
                      { key: 'cmp', name: 'Trips ended', color: SERIES[1], values: tl.map((p) => p.completed) },
                      { key: 'paid', name: 'Paid', color: SERIES[3], values: tl.map((p) => p.paid) },
                    ]}
                  />
                </div>
              )}

              {!active && sim.totals.requested > 0 && (
                <section aria-label="What happened">
                  <h2 className="font-display text-[28px] font-semibold">What happened</h2>
                  <ul className="mt-3 flex max-w-3xl list-disc flex-col gap-2 pl-5 text-[15px] leading-7 text-ink-2">
                    {findings(sim).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  {sim.fleet.cleanup && (
                    <p className="mt-3 text-[13px] text-muted">
                      Removed {sim.fleet.cleanup.removed} simulated cars{sim.fleet.cleanup.busy ? `; ${sim.fleet.cleanup.busy} still finishing a trip` : ''}.
                    </p>
                  )}
                </section>
              )}

              {tl.length > 1 && (
                <details className="text-[13px]">
                  <summary className="cursor-pointer font-medium text-ink-2">Second-by-second table</summary>
                  <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-line">
                    <table className="w-full text-right tabular-nums">
                      <thead className="sticky top-0 bg-paper text-muted">
                        <tr>
                          {['Second', 'Requested', 'Matched', 'No car', 'Failed', 'Ended', 'Paid', 'Booking p95', 'Busy / fleet', 'Jobs', 'Events', 'Counted / finished'].map((h) => (
                            <th key={h} className="px-2.5 py-2 font-medium">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tl.map((p) => (
                          <tr key={p.t} className="border-t border-line">
                            <td className="px-2.5 py-1.5">{p.t}</td>
                            <td className="px-2.5">{p.requested}</td>
                            <td className="px-2.5">{p.assigned}</td>
                            <td className="px-2.5">{p.noDriver}</td>
                            <td className="px-2.5">{p.failed}</td>
                            <td className="px-2.5">{p.completed}</td>
                            <td className="px-2.5">{p.paid}</td>
                            <td className="px-2.5">{ms(p.bookingP95)}</td>
                            <td className="px-2.5">{p.busyDrivers ?? '—'} / {p.totalDrivers ?? '—'}</td>
                            <td className="px-2.5">{p.jobsPending ?? '—'}</td>
                            <td className="px-2.5">{p.queueDepth ?? '—'}</td>
                            <td className="px-2.5">{p.projectedCompleted ?? '—'} / {p.expectedCompleted ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
