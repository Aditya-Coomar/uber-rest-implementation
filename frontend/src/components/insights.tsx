'use client';

import { useEffect, useState } from 'react';
import { AnalyticsSummary, ApiError, PipelineStatus, ridesApi } from '@/lib/api';
import { compact, distance, minutes, money, percent } from '@/lib/format';

const JOB_NAMES: Record<string, string> = {
  MATCH: 'Driver matching',
  RELEASE_DRIVER: 'Driver release',
  CHARGE: 'Payments',
  PUBLISH_RIDE_COMPLETED: 'Trip-ended events',
  PUBLISH_RIDE_CANCELLED: 'Cancellation events',
  PUBLISH_PAYMENT_SETTLED: 'Payment events',
};

/** City-wide numbers from the analytics projection, plus the live state of the pipeline that feeds it. */
export default function Insights() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const [s, p] = await Promise.allSettled([ridesApi.analytics(controller.signal), ridesApi.pipeline(controller.signal)]);
      if (controller.signal.aborted) return;
      if (s.status === 'fulfilled') {
        setSummary(s.value);
        setError(null);
      } else setError(s.reason instanceof ApiError ? s.reason.message : 'Analytics are unavailable right now.');
      if (p.status === 'fulfilled') setPipeline(p.value);
      timer = setTimeout(load, 3_000);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  const s = summary;
  const rows: Array<[string, string, string]> = s
    ? [
        ['Trips cancelled', compact(s.cancelledTrips), `${percent(s.completionRate)} of trips that started were completed`],
        ['Fares booked', money(s.grossBookingsMinor, s.currency), 'Sum of fixed upfront fares for completed trips'],
        ['Collected', money(s.collectedMinor, s.currency), `${money(s.declinedMinor, s.currency)} declined at the bank and retried or still owed`],
        ['Average fare', s.averageFareMinor === null ? '—' : money(s.averageFareMinor, s.currency), 'Per completed trip'],
        ['Average distance', s.averageDistanceMeters === null ? '—' : distance(s.averageDistanceMeters), `${distance(s.totalDistanceMeters)} driven in total`],
        ['Average time in car', s.averageDurationSeconds === null ? '—' : s.averageDurationSeconds < 60 ? `${s.averageDurationSeconds} s` : minutes(s.averageDurationSeconds), 'From driver assigned to trip end (demo time is compressed)'],
        ['Bank approval rate', percent(s.approvalRate), `${compact(s.paymentsApproved)} approved · ${compact(s.paymentsDeclined)} declined`],
      ]
    : [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-12 px-5 pb-16 pt-24 lg:px-8">
      <header>
        <p className="text-[15px] text-ink-2">Across the city, all time</p>
        <p className="mt-2 font-display text-[88px] font-semibold leading-[0.85] tabular-nums lg:text-[128px]" aria-live="polite">
          {s ? compact(s.completedTrips) : '—'}
        </p>
        <p className="mt-3 font-display text-[26px] font-semibold">trips completed</p>
        <p className="mt-2 text-[14px] text-muted">
          {s?.updatedAt ? `Last trip counted at ${new Date(s.updatedAt).toLocaleTimeString()}` : 'No trips counted yet'} · refreshes every few seconds
        </p>
        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-bad-wash px-3.5 py-2.5 text-[14px] text-bad">
            {error}
          </p>
        )}
      </header>

      {s && (
        <dl className="divide-y divide-line border-y border-line">
          {rows.map(([label, value, note]) => (
            <div key={label} className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 py-4 sm:grid-cols-[14rem_10rem_1fr]">
              <dt className="text-[15px] text-ink-2">{label}</dt>
              <dd className="text-right font-display text-[28px] font-semibold tabular-nums sm:text-left">{value}</dd>
              <dd className="col-span-2 text-[13.5px] text-muted sm:col-span-1">{note}</dd>
            </div>
          ))}
        </dl>
      )}

      <section aria-labelledby="pipeline-h" className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <h2 id="pipeline-h" className="font-display text-[28px] font-semibold">How these numbers arrive</h2>
          <p className="mt-3 text-[15px] leading-7 text-ink-2">
            Ending a trip never waits for analytics. Each trip end, cancellation and payment is written to an event archive, delivered through a queue,
            and counted exactly once. The archive can rebuild every number here from scratch.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 self-start">
          <div>
            <dt className="text-[13px] text-muted">Background worker</dt>
            <dd className="mt-1 flex items-center gap-2 text-[17px] font-semibold">
              <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${pipeline?.worker.state === 'RUNNING' ? 'bg-good' : pipeline?.worker.state === 'PAUSED' ? 'bg-amber' : 'bg-bad'}`} />
              {pipeline ? { RUNNING: 'Running', PAUSED: 'Paused for a rebuild', STOPPED: 'Stopped', UNKNOWN: 'Unknown' }[pipeline.worker.state] ?? pipeline.worker.state : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted">Events waiting in the queue</dt>
            <dd className="mt-1 font-display text-[26px] font-semibold tabular-nums">
              {pipeline?.eventQueue ? pipeline.eventQueue.visible + pipeline.eventQueue.inFlight : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted">Jobs pending</dt>
            <dd className="mt-1 font-display text-[26px] font-semibold tabular-nums">{pipeline ? pipeline.jobs.total : '—'}</dd>
            {pipeline && pipeline.jobs.total > 0 && (
              <dd className="mt-1 text-[13px] text-ink-2">
                {Object.entries(pipeline.jobs.byKind)
                  .map(([k, n]) => `${JOB_NAMES[k] ?? k}: ${n}`)
                  .join(', ')}
              </dd>
            )}
          </div>
          <div>
            <dt className="text-[13px] text-muted">Unreadable messages set aside</dt>
            <dd className="mt-1 font-display text-[26px] font-semibold tabular-nums">
              {pipeline?.deadLetterQueue ? pipeline.deadLetterQueue.visible + pipeline.deadLetterQueue.inFlight : '—'}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
