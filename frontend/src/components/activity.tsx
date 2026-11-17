'use client';

import { useEffect, useState } from 'react';
import { Ride, ridesApi } from '@/lib/api';
import { cardLabel, dateTime, declineReason, distance, money } from '@/lib/format';
import { KEYS, useLocal } from '@/lib/use-local';

const STATUS: Record<string, string> = {
  PENDING_MATCH: 'Finding driver',
  ASSIGNED: 'In progress',
  NO_DRIVER: 'No car found',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** Trips booked from this browser. */
export default function Activity({ onOpenRide }: { onOpenRide: () => void }) {
  const [tripIds] = useLocal<string[]>(KEYS.trips);
  const [, setActive] = useLocal<string>(KEYS.activeRide);
  const [rides, setRides] = useState<Ride[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const idsKey = (tripIds ?? []).join(',');

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    const controller = new AbortController();
    Promise.allSettled(ids.map((id) => ridesApi.getRide(id, controller.signal))).then((results) => {
      if (controller.signal.aborted) return;
      setRides(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
    });
    return () => controller.abort();
  }, [idsKey]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-5 pb-16 pt-24">
      <h1 className="font-display text-[44px] font-semibold leading-none">Your trips</h1>
      {rides === null ? (
        <p className="text-ink-2">Loading…</p>
      ) : rides.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-line p-8">
          <p className="text-[16px] font-medium">No trips yet</p>
          <p className="mt-1 text-[14px] text-ink-2">Your rides will appear here with receipts.</p>
          <button type="button" className="mt-4 rounded-xl bg-ink px-4 py-2.5 text-[15px] font-semibold text-white" onClick={onOpenRide}>
            Book a ride
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rides.map((r) => {
            const live = r.status === 'PENDING_MATCH' || r.status === 'ASSIGNED' || r.payment.status === 'PENDING' || r.payment.status === 'DECLINED';
            return (
              <li key={r.rideId} className="py-4">
                <button type="button" className="grid w-full grid-cols-[1fr_auto] gap-x-4 text-left" onClick={() => setOpen(open === r.rideId ? null : r.rideId)} aria-expanded={open === r.rideId}>
                  <span>
                    <span className="block text-[16px] font-semibold">
                      {r.pickup.label} to {r.destination.label}
                    </span>
                    <span className="block text-[13.5px] text-ink-2">
                      {dateTime(r.createdAt)} · {STATUS[r.status]}
                      {r.driver ? ` · ${r.driver.name}` : ''}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className={`block font-display text-[20px] font-semibold tabular-nums ${r.status === 'CANCELLED' || r.status === 'NO_DRIVER' ? 'text-muted line-through' : ''}`}>
                      {money(r.fare.amountMinor, r.fare.currency)}
                    </span>
                    <span className={`block text-[13px] ${r.payment.status === 'DECLINED' ? 'text-bad' : r.payment.status === 'PAID' ? 'text-good' : 'text-muted'}`}>
                      {r.payment.status === 'PAID' ? 'Paid' : r.payment.status === 'DECLINED' ? 'Payment due' : r.payment.status === 'PENDING' ? 'Processing' : 'Not charged'}
                    </span>
                  </span>
                </button>
                {open === r.rideId && (
                  <div className="kerb-step mt-4 rounded-2xl bg-land p-4 text-[14px]">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
                      <dt className="text-muted">Distance</dt>
                      <dd>{distance(r.fare.distanceMeters)}</dd>
                      <dt className="text-muted">Fare</dt>
                      <dd>
                        {money(r.fare.baseMinor)} base + {money(r.fare.distanceMinor)} distance
                      </dd>
                      {r.driver && (
                        <>
                          <dt className="text-muted">Driver</dt>
                          <dd>
                            {r.driver.name} · {r.driver.vehicle} {r.driver.plate ? `· ${r.driver.plate}` : ''}
                          </dd>
                        </>
                      )}
                      <dt className="text-muted">Card</dt>
                      <dd>{cardLabel(r.payment.method)}</dd>
                      {r.payment.attempts.map((a) => (
                        <span key={a.attemptId} className="contents">
                          <dt className="text-muted">{dateTime(a.settledAt)}</dt>
                          <dd>
                            {cardLabel(a.method)}: {a.status === 'PAID' ? 'approved' : declineReason(a.declineCode).toLowerCase()}
                          </dd>
                        </span>
                      ))}
                      <dt className="text-muted">Ride ID</dt>
                      <dd className="break-all text-[12.5px]">{r.rideId}</dd>
                    </dl>
                    {live && (
                      <button
                        type="button"
                        className="mt-4 rounded-xl bg-ink px-4 py-2.5 text-[14px] font-semibold text-white"
                        onClick={() => {
                          setActive(r.rideId);
                          onOpenRide();
                        }}
                      >
                        {r.payment.status === 'DECLINED' ? 'Pay now' : 'Open trip'}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
