'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, FareQuote, NearbyDrivers, Ride, newIdempotencyKey, ridesApi } from '@/lib/api';
import { SavedCard, cardToken } from '@/lib/card';
import { cardLabel, clockTime, declineReason, distance, minutes, money } from '@/lib/format';
import { Pt, along, approachStart, project, streetRoute } from '@/lib/geo';
import { DEFAULT_PICKUP, PLACES, Place, placeById } from '@/lib/places';
import { KEYS, ensureRiderId, rememberTrip, useLocal } from '@/lib/use-local';
import CardForm from './card-form';
import CityMap from './city-map';
import { useMediaQuery } from './use-media-query';

type Step = 'home' | 'search' | 'options';
type Phase = 'enroute' | 'arrived' | 'ontrip' | 'done';
interface TripClock {
  startedAt: number;
  skipMs: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Simulated trip timing (compressed): approach, wait at pickup, ride. */
function tripPlan(ride: Ride) {
  const approach = clamp((ride.pickupEtaSeconds ?? 120) / 12, 5, 14) * 1000;
  const wait = 4_000;
  const travel = clamp(ride.estimatedDurationSeconds / 15, 8, 22) * 1000;
  return { approach, wait, travel, total: approach + wait + travel };
}

function phaseAt(ride: Ride, elapsed: number): { phase: Phase; t: number; remainingMs: number } {
  const p = tripPlan(ride);
  if (elapsed < p.approach) return { phase: 'enroute', t: elapsed / p.approach, remainingMs: p.approach - elapsed };
  if (elapsed < p.approach + p.wait) return { phase: 'arrived', t: 1, remainingMs: p.approach + p.wait - elapsed };
  if (elapsed < p.total) return { phase: 'ontrip', t: (elapsed - p.approach - p.wait) / p.travel, remainingMs: p.total - elapsed };
  return { phase: 'done', t: 1, remainingMs: 0 };
}

/** A four-digit code the rider reads to the driver (derived from the ride). */
function ridePin(rideId: string): string {
  let h = 7;
  for (let i = 0; i < rideId.length; i += 1) h = (h * 31 + rideId.charCodeAt(i)) >>> 0;
  return String(1000 + (h % 9000));
}

const initials = (name: string) => name.split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();

export default function RideTab() {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [card, setCard] = useLocal<SavedCard>(KEYS.card);
  const [activeRideId, setActiveRideId] = useLocal<string>(KEYS.activeRide);
  const [step, setStep] = useState<Step>('home');
  const [pickupId, setPickupId] = useState(DEFAULT_PICKUP.id);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [editing, setEditing] = useState<'pickup' | 'destination'>('destination');
  const [query, setQuery] = useState('');
  const [quote, setQuote] = useState<FareQuote | null>(null);
  const [nearby, setNearby] = useState<NearbyDrivers | null>(null);
  const [ride, setRide] = useState<Ride | null>(null);
  const [busy, setBusy] = useState<null | 'book' | 'cancel' | 'pay'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [now, setNow] = useState(0);
  const bookingKey = useRef<{ key: string; fingerprint: string } | null>(null);
  const retryKey = useRef<{ key: string; fingerprint: string } | null>(null);
  const completing = useRef<string | null>(null);
  const inFlight = useRef(false);

  const pickup = placeById(pickupId) ?? DEFAULT_PICKUP;
  const destination = destinationId ? placeById(destinationId) ?? null : null;
  const shownRide = ride && ride.rideId === activeRideId ? ride : null;
  const [clock, setClock] = useLocal<TripClock>(KEYS.clock(activeRideId ?? 'none'));

  // ------------------------------------------------------------ data loading

  // Load the active ride (also after a reload).
  useEffect(() => {
    if (!activeRideId) return;
    const controller = new AbortController();
    ridesApi
      .getRide(activeRideId, controller.signal)
      .then(setRide)
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) setActiveRideId(null);
        else setNotice(err instanceof ApiError ? err.message : 'Couldn’t load your ride.');
      });
    return () => controller.abort();
  }, [activeRideId, setActiveRideId]);

  // Poll while matching or payment is unresolved.
  const pending = shownRide !== null && (shownRide.status === 'PENDING_MATCH' || shownRide.payment.status === 'PENDING');
  useEffect(() => {
    if (!activeRideId || !pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const latest = await ridesApi.getRide(activeRideId, controller.signal);
        if (!controller.signal.aborted) setRide(latest);
      } catch {
        /* transient; keep polling */
      }
      if (!controller.signal.aborted) timer = setTimeout(tick, 1_200);
    };
    timer = setTimeout(tick, 1_200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeRideId, pending]);

  // Nearby cars around the pickup while planning.
  useEffect(() => {
    if (activeRideId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      ridesApi
        .nearby(pickup, controller.signal)
        .then((n) => setNearby(n))
        .catch(() => {
          if (!controller.signal.aborted) setNearby(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) timer = setTimeout(load, 8_000);
        });
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeRideId, pickup]);

  // Upfront fare quote for the chosen trip.
  useEffect(() => {
    if (!destination || step !== 'options') return;
    const controller = new AbortController();
    ridesApi
      .quote(pickup, destination, controller.signal)
      .then(setQuote)
      .catch((err) => {
        if (!controller.signal.aborted) setNotice(err instanceof ApiError ? err.message : 'Couldn’t price this trip.');
      });
    return () => controller.abort();
  }, [pickup, destination, step]);

  // ------------------------------------------------------------ trip clock

  const assigned = shownRide?.status === 'ASSIGNED';
  useEffect(() => {
    if (assigned && activeRideId && !clock) setClock({ startedAt: Date.now(), skipMs: 0 });
  }, [assigned, activeRideId, clock, setClock]);

  const trip = shownRide && assigned && clock && now > 0 ? phaseAt(shownRide, now - clock.startedAt + clock.skipMs) : null;

  const completeRide = useCallback(async (rideId: string) => {
    if (completing.current === rideId) return;
    completing.current = rideId;
    try {
      setRide(await ridesApi.completeRide(rideId));
    } catch (err) {
      completing.current = null;
      setNotice(err instanceof ApiError ? err.message : 'Couldn’t end the trip. We’ll keep trying.');
      ridesApi.getRide(rideId).then(setRide).catch(() => undefined);
    }
  }, []);

  // Animation clock. It also ends the trip when the car reaches the drop-off
  // (the driver ends the trip on arrival), so completion is driven by the clock, not by render.
  const tripRef = useRef<{ ride: Ride; clock: TripClock } | null>(null);
  useEffect(() => {
    tripRef.current = shownRide && clock ? { ride: shownRide, clock } : null;
  });
  useEffect(() => {
    if (!assigned) return;
    let frame = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 33) {
        last = t;
        const current = Date.now();
        setNow(current);
        const active = tripRef.current;
        if (active && active.ride.status === 'ASSIGNED') {
          const { phase } = phaseAt(active.ride, current - active.clock.startedAt + active.clock.skipMs);
          if (phase === 'done') void completeRide(active.ride.rideId);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [assigned, completeRide]);

  // ------------------------------------------------------------ actions

  async function run(action: NonNullable<typeof busy>, fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setNotice(null);
    try {
      await fn();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const openRide = (r: Ride) => {
    setRide(r);
    setActiveRideId(r.rideId);
    rememberTrip(r.rideId);
  };

  const requestRide = (from: { lat: number; lng: number; label?: string }, to: { lat: number; lng: number; label?: string }) =>
    run('book', async () => {
      if (!card) {
        setAddingCard(true);
        return;
      }
      const input = {
        riderId: ensureRiderId(),
        pickup: { lat: from.lat, lng: from.lng, label: from.label },
        destination: { lat: to.lat, lng: to.lng, label: to.label },
        paymentMethodId: cardToken(card),
      };
      const fingerprint = JSON.stringify(input);
      if (bookingKey.current?.fingerprint !== fingerprint) bookingKey.current = { key: newIdempotencyKey('book'), fingerprint };
      try {
        const { ride: booked } = await ridesApi.bookRide(input, bookingKey.current.key);
        bookingKey.current = null;
        openRide(booked);
      } catch (err) {
        const rideId = err instanceof ApiError && typeof err.details.rideId === 'string' ? err.details.rideId : null;
        if (rideId) {
          // Pending match or a confirmed no-driver: the ride exists either way.
          bookingKey.current = null;
          try {
            openRide(await ridesApi.getRide(rideId));
          } catch {
            setNotice('Your request was saved. Reconnecting…');
            setActiveRideId(rideId);
          }
          return;
        }
        if (!(err instanceof ApiError && err.retryable)) bookingKey.current = null;
        setNotice(err instanceof ApiError ? err.message : 'Couldn’t request a ride.');
      }
    });

  const cancelRide = () =>
    run('cancel', async () => {
      if (!shownRide) return;
      try {
        setRide(await ridesApi.cancelRide(shownRide.rideId));
      } catch (err) {
        setNotice(err instanceof ApiError ? err.message : 'Couldn’t cancel the ride.');
        ridesApi.getRide(shownRide.rideId).then(setRide).catch(() => undefined);
      } finally {
        setConfirmCancel(false);
      }
    });

  const payWithCard = (newCard: SavedCard) =>
    run('pay', async () => {
      if (!shownRide) return;
      setCard(newCard);
      const token = cardToken(newCard);
      const fingerprint = `${shownRide.rideId}|${shownRide.payment.attemptId}|${token}`;
      if (retryKey.current?.fingerprint !== fingerprint) retryKey.current = { key: newIdempotencyKey('pay'), fingerprint };
      try {
        setRide(await ridesApi.retryPayment(shownRide.rideId, token, retryKey.current.key));
        retryKey.current = null;
      } catch (err) {
        if (!(err instanceof ApiError && err.retryable)) retryKey.current = null;
        setNotice(err instanceof ApiError ? err.message : 'Couldn’t start the payment.');
        ridesApi.getRide(shownRide.rideId).then(setRide).catch(() => undefined);
      }
    });

  const finish = () => {
    if (activeRideId) window.localStorage.removeItem(KEYS.clock(activeRideId));
    setActiveRideId(null);
    setRide(null);
    setStep('home');
    setDestinationId(null);
    setQuote(null);
    setNotice(null);
    setAddingCard(false);
  };

  const skipAhead = () => {
    if (!clock || !trip) return;
    setClock({ ...clock, skipMs: clock.skipMs + trip.remainingMs + 50 });
  };

  // ------------------------------------------------------------ map state

  const mapState = useMemo(() => {
    if (shownRide) {
      const pu = shownRide.pickup;
      const de = shownRide.destination;
      const tripRoute = streetRoute(project(pu.lat, pu.lng), project(de.lat, de.lng));
      if (shownRide.status === 'ASSIGNED' && shownRide.driver) {
        const start = approachStart(pu, shownRide.pickupDistanceMeters ?? 600, shownRide.driver.driverId);
        const approach = streetRoute(project(start.lat, start.lng), project(pu.lat, pu.lng));
        if (!trip || trip.phase === 'enroute') {
          return { focus: [start, pu], pickup: pu, destination: de, route: approach, progress: trip?.t ?? 0, car: along(approach, trip?.t ?? 0), searching: false };
        }
        if (trip.phase === 'arrived') {
          return { focus: [pu, de], pickup: pu, destination: de, route: tripRoute, progress: 0, car: along(tripRoute, 0), searching: false };
        }
        return { focus: [pu, de], pickup: pu, destination: de, route: tripRoute, progress: trip.t, car: along(tripRoute, trip.t), searching: false };
      }
      if (shownRide.status === 'COMPLETED') {
        return { focus: [pu, de], pickup: pu, destination: de, route: tripRoute, progress: 1, car: along(tripRoute, 1), searching: false };
      }
      return { focus: [pu], pickup: pu, destination: shownRide.status === 'PENDING_MATCH' ? de : null, route: null, progress: 0, car: null, searching: shownRide.status === 'PENDING_MATCH' };
    }
    if (destination) {
      const route = streetRoute(project(pickup.lat, pickup.lng), project(destination.lat, destination.lng));
      return { focus: [pickup, destination], pickup, destination, route, progress: 0, car: null, searching: false };
    }
    return { focus: [pickup, ...(nearby?.drivers.slice(0, 4) ?? [])], pickup, destination: null, route: null as Pt[] | null, progress: 0, car: null, searching: false };
  }, [shownRide, trip, pickup, destination, nearby]);

  // ------------------------------------------------------------ render

  const sheetBody = () => {
    if (activeRideId && !shownRide) {
      return <p className="py-6 text-ink-2">Loading your ride…</p>;
    }
    if (shownRide) return renderRide(shownRide);
    if (addingCard) {
      return (
        <CardForm
          title="Add a card"
          submitLabel="Save card"
          onCancel={() => setAddingCard(false)}
          onSubmit={(c) => {
            setCard(c);
            setAddingCard(false);
          }}
        />
      );
    }
    if (step === 'search') return renderSearch();
    if (step === 'options' && destination) return renderOptions(destination);
    return renderHome();
  };

  const renderHome = () => (
    <div className="kerb-step flex flex-col gap-5">
      <div>
        <h1 className="font-display text-[34px] font-semibold leading-none">Where to?</h1>
        <p className="mt-2 text-[15px] text-ink-2">
          {nearby
            ? nearby.drivers.length > 0
              ? `${nearby.drivers.length} ${nearby.drivers.length === 1 ? 'car' : 'cars'} near ${pickup.label} · nearest ${minutes(nearby.nearestEtaSeconds ?? 60)} away`
              : `No cars near ${pickup.label} right now`
            : `Picking you up at ${pickup.label}`}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          setEditing('destination');
          setQuery('');
          setStep('search');
        }}
        className="flex items-center gap-3 rounded-2xl bg-land px-4 py-4 text-left text-[17px] font-medium text-ink-2 transition-colors hover:bg-[#dfe2d9]"
      >
        <span aria-hidden className="inline-block h-3 w-3 bg-ink" />
        Search destination
      </button>
      <div>
        <p className="mb-2 text-[13px] font-medium text-muted">Popular from {pickup.label}</p>
        <ul className="divide-y divide-line">
          {PLACES.filter((p) => p.id !== pickup.id).slice(0, 4).map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 py-3 text-left hover:text-ink"
                onClick={() => {
                  setDestinationId(p.id);
                  setStep('options');
                }}
              >
                <span>
                  <span className="block text-[15px] font-medium">{p.label}</span>
                  <span className="block text-[13px] text-muted">{p.area}</span>
                </span>
                <span className="text-[13px] tabular-nums text-muted">{distance(haversine(pickup, p))}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="self-start text-[14px] font-medium text-ink-2 underline underline-offset-4"
        onClick={() => {
          setEditing('pickup');
          setQuery('');
          setStep('search');
        }}
      >
        Change pickup ({pickup.label})
      </button>
    </div>
  );

  const renderSearch = () => {
    const matches = PLACES.filter((p) => `${p.label} ${p.area}`.toLowerCase().includes(query.trim().toLowerCase())).filter((p) =>
      editing === 'destination' ? p.id !== pickup.id : p.id !== destinationId,
    );
    return (
      <div className="kerb-step flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[24px] font-semibold">Plan your ride</h2>
          <button type="button" className="text-[14px] font-medium text-ink-2 hover:underline" onClick={() => setStep(destination ? 'options' : 'home')}>
            Close
          </button>
        </div>
        <div className="flex flex-col gap-2 rounded-2xl bg-land p-2">
          {(['pickup', 'destination'] as const).map((f) => (
            <label key={f} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${editing === f ? 'bg-white shadow-[0_0_0_1.5px_var(--ink)]' : ''}`}>
              <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 ${f === 'pickup' ? 'rounded-full bg-ink' : 'bg-ink'}`} />
              <span className="sr-only">{f === 'pickup' ? 'Pickup' : 'Destination'}</span>
              <input
                className="w-full bg-transparent text-[15px] outline-none placeholder:text-muted"
                placeholder={f === 'pickup' ? pickup.label : destination?.label ?? 'Where to?'}
                value={editing === f ? query : f === 'pickup' ? pickup.label : destination?.label ?? ''}
                onFocus={() => {
                  setEditing(f);
                  setQuery('');
                }}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus={editing === f}
              />
            </label>
          ))}
        </div>
        <ul className="divide-y divide-line">
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 py-3 text-left"
                onClick={() => {
                  if (editing === 'pickup') {
                    setPickupId(p.id);
                    if (destinationId === p.id) setDestinationId(null);
                    setStep(destinationId && destinationId !== p.id ? 'options' : 'home');
                  } else {
                    setDestinationId(p.id);
                    setStep('options');
                  }
                  setQuote(null);
                }}
              >
                <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-land text-[15px]">
                  ⌖
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium">{p.label}</span>
                  <span className="block truncate text-[13px] text-muted">{p.area}</span>
                </span>
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="py-4 text-[14px] text-muted">No places match “{query}”. Try another name.</li>}
        </ul>
      </div>
    );
  };

  const renderOptions = (dest: Place) => (
    <div className="kerb-step flex flex-col gap-5">
      <button type="button" className="flex flex-col gap-1 rounded-2xl bg-land px-4 py-3 text-left" onClick={() => setStep('search')}>
        <span className="flex items-center gap-2.5 text-[15px] font-medium">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-ink" /> {pickup.label}
        </span>
        <span className="ml-[4px] h-3 border-l-2 border-dotted border-muted" aria-hidden />
        <span className="flex items-center gap-2.5 text-[15px] font-medium">
          <span aria-hidden className="inline-block h-2.5 w-2.5 bg-ink" /> {dest.label}
        </span>
      </button>

      <div className="rounded-2xl border-2 border-ink p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[17px] font-semibold">Kerb Go</p>
            <p className="text-[13.5px] text-ink-2">
              4 seats · {nearby?.nearestEtaSeconds ? `${minutes(nearby.nearestEtaSeconds)} away` : 'checking nearby cars'}
            </p>
          </div>
          <p className="font-display text-[30px] font-semibold leading-none tabular-nums">{quote ? money(quote.fare.amountMinor, quote.fare.currency) : '—'}</p>
        </div>
        {quote && (
          <details className="group mt-3 text-[13.5px] text-ink-2">
            <summary className="cursor-pointer list-none font-medium text-ink underline-offset-4 hover:underline">
              {distance(quote.fare.distanceMeters)} · about {minutes(quote.estimatedDurationSeconds)} · Fare details
            </summary>
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1">
              <dt>Base fare</dt>
              <dd className="tabular-nums">{money(quote.fare.baseMinor)}</dd>
              <dt>
                Distance ({distance(quote.fare.distanceMeters)} at {money(quote.fare.perKmMinor)}/km)
              </dt>
              <dd className="tabular-nums">{money(quote.fare.distanceMinor)}</dd>
              <dt className="font-semibold text-ink">Total, fixed upfront</dt>
              <dd className="font-semibold tabular-nums text-ink">{money(quote.fare.amountMinor)}</dd>
            </dl>
          </details>
        )}
      </div>

      <button type="button" onClick={() => setAddingCard(true)} className="flex items-center justify-between rounded-2xl px-1 py-1 text-left">
        <span className="flex items-center gap-3">
          <span aria-hidden className="grid h-8 w-11 place-items-center rounded-md bg-ink text-[10px] font-bold text-white">
            {card ? card.brand.slice(0, 4).toUpperCase() : '+'}
          </span>
          <span className="text-[15px] font-medium">{card ? cardLabel(card) : 'Add a card to ride'}</span>
        </span>
        <span className="text-[14px] font-medium text-ink-2">{card ? 'Change' : 'Add'}</span>
      </button>

      <button
        type="button"
        disabled={busy === 'book' || !quote}
        onClick={() => (card ? requestRide(pickup, dest) : setAddingCard(true))}
        className="h-14 rounded-2xl bg-ink text-[17px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy === 'book' ? 'Requesting…' : card ? 'Request Kerb Go' : 'Add a card to continue'}
      </button>
    </div>
  );

  const renderRide = (r: Ride) => {
    if (r.status === 'PENDING_MATCH') {
      return (
        <div className="kerb-step flex flex-col gap-3 py-2">
          <h2 className="font-display text-[28px] font-semibold leading-tight">Finding your driver</h2>
          <p className="text-[15px] text-ink-2">
            Matching is taking longer than usual. Your request is saved and will go through as soon as a driver is confirmed — you don’t need to request
            again.
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-land" aria-hidden>
            <div className="h-full w-1/3 animate-pulse rounded-full bg-amber" />
          </div>
          <TripSummary ride={r} />
        </div>
      );
    }
    if (r.status === 'NO_DRIVER') {
      return (
        <div className="kerb-step flex flex-col gap-4 py-2">
          <h2 className="font-display text-[28px] font-semibold leading-tight">No cars available</h2>
          <p className="text-[15px] text-ink-2">
            Every driver near {r.pickup.label ?? 'you'} is on a trip. Cars free up every few minutes — try again shortly. You haven’t been charged.
          </p>
          <div className="flex gap-3">
            <button type="button" className="h-12 flex-1 rounded-2xl bg-ink font-semibold text-white disabled:opacity-60" disabled={busy !== null} onClick={() => requestRide(r.pickup, r.destination)}>
              {busy === 'book' ? 'Requesting…' : 'Try again'}
            </button>
            <button type="button" className="h-12 rounded-2xl border border-line px-5 font-semibold" onClick={finish}>
              Change trip
            </button>
          </div>
        </div>
      );
    }
    if (r.status === 'CANCELLED') {
      return (
        <div className="kerb-step flex flex-col gap-4 py-2">
          <h2 className="font-display text-[28px] font-semibold leading-tight">Ride cancelled</h2>
          <p className="text-[15px] text-ink-2">
            {r.driver ? `${r.driver.name} has been released for other riders.` : ''} You weren’t charged.
          </p>
          <button type="button" className="h-12 rounded-2xl bg-ink font-semibold text-white" onClick={finish}>
            Done
          </button>
        </div>
      );
    }
    if (r.status === 'COMPLETED') return renderPayment(r);
    return renderAssigned(r);
  };

  const renderAssigned = (r: Ride) => {
    const d = r.driver!;
    const phase = trip?.phase ?? 'enroute';
    const plan = tripPlan(r);
    // Real-world minutes, scaled from the compressed demo clock.
    const approachLeft = trip?.phase === 'enroute' ? trip.remainingMs / plan.approach : 1;
    const etaReal = r.pickupEtaSeconds ? Math.max(1, Math.round((r.pickupEtaSeconds * approachLeft) / 60)) : null;
    const tripReal = Math.max(1, Math.round((r.estimatedDurationSeconds * (trip?.phase === 'ontrip' ? 1 - trip.t : 1)) / 60));
    const headline =
      phase === 'enroute' ? `${d.name} is ${etaReal ?? '—'} min away` : phase === 'arrived' ? `${d.name} has arrived` : phase === 'ontrip' ? `${tripReal} min to ${r.destination.label ?? 'destination'}` : 'You’ve arrived';
    const sub =
      phase === 'enroute'
        ? `Meet at ${r.pickup.label ?? 'the pickup point'}`
        : phase === 'arrived'
          ? `Look for the ${d.vehicle.toLowerCase()} at ${r.pickup.label ?? 'the pickup'}`
          : phase === 'ontrip'
            ? `Arriving around ${clockTime(new Date(now + tripReal * 60_000).toISOString())}`
            : 'Ending your trip…';
    const segments: Phase[] = ['enroute', 'arrived', 'ontrip'];
    const current = segments.indexOf(phase === 'done' ? 'ontrip' : phase);
    return (
      <div className="kerb-step flex flex-col gap-5">
        <div>
          <h2 className="font-display text-[30px] font-semibold leading-[1.05]" aria-live="polite">
            {headline}
          </h2>
          <p className="mt-1.5 text-[15px] text-ink-2">{sub}</p>
          <div className="mt-4 grid grid-cols-3 gap-1.5" aria-hidden>
            {segments.map((s, i) => (
              <div key={s} className="h-1.5 overflow-hidden rounded-full bg-land">
                <div
                  className="h-full rounded-full bg-amber"
                  style={{ width: i < current ? '100%' : i === current ? `${Math.round((s === 'arrived' ? 1 - (trip?.remainingMs ?? 0) / plan.wait : trip?.t ?? 0) * 100)}%` : '0%' }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div aria-hidden className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-amber font-display text-[20px] font-semibold text-ink">
            {initials(d.name)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[17px] font-semibold">
              {d.name} {d.rating !== undefined && <span className="ml-1 text-[14px] font-medium text-ink-2">★ {d.rating.toFixed(2)}</span>}
            </p>
            <p className="truncate text-[14px] text-ink-2">{d.vehicle}</p>
          </div>
          {d.plate && (
            <div className="rounded-md border-2 border-ink bg-white px-2.5 py-1 text-center font-display text-[16px] font-bold leading-tight tracking-wide tabular-nums">
              {d.plate}
            </div>
          )}
        </div>

        {(phase === 'enroute' || phase === 'arrived') && (
          <div className="flex items-center justify-between rounded-2xl bg-amber-wash px-4 py-3">
            <span className="text-[14px] text-ink">Share this PIN with your driver</span>
            <span className="font-display text-[26px] font-bold tracking-[0.18em] tabular-nums">{ridePin(r.rideId)}</span>
          </div>
        )}

        <TripSummary ride={r} />

        <div className="flex flex-wrap items-center gap-3">
          {(phase === 'enroute' || phase === 'arrived') &&
            (confirmCancel ? (
              <div className="flex w-full flex-col gap-2 rounded-2xl border border-line p-3">
                <p className="text-[14px]">Cancel this ride? {d.name} will be released. You won’t be charged.</p>
                <div className="flex gap-2">
                  <button type="button" className="h-11 flex-1 rounded-xl bg-bad font-semibold text-white disabled:opacity-60" onClick={cancelRide} disabled={busy !== null}>
                    {busy === 'cancel' ? 'Cancelling…' : 'Cancel ride'}
                  </button>
                  <button type="button" className="h-11 flex-1 rounded-xl border border-line font-semibold" onClick={() => setConfirmCancel(false)}>
                    Keep ride
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="h-11 rounded-xl border border-line px-4 text-[15px] font-semibold" onClick={() => setConfirmCancel(true)}>
                Cancel ride
              </button>
            ))}
          {phase !== 'done' && (
            <button type="button" className="ml-auto text-[13.5px] font-medium text-ink-2 underline underline-offset-4" onClick={skipAhead} title="The demo runs trips in compressed time">
              {phase === 'enroute' ? 'Skip to pickup' : phase === 'arrived' ? 'Start trip now' : 'Skip to drop-off'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderPayment = (r: Ride) => {
    const method = cardLabel(r.payment.method);
    if (r.payment.status === 'PENDING') {
      return (
        <div className="kerb-step flex flex-col gap-4 py-1" aria-live="polite">
          <h2 className="font-display text-[30px] font-semibold leading-tight">You’ve arrived</h2>
          <ol className="flex flex-col gap-3 text-[15px]">
            <li className="flex items-center gap-3">
              <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full bg-good text-[13px] text-white">✓</span>
              Trip ended at {r.completedAt ? clockTime(r.completedAt) : '—'}
            </li>
            <li className="flex items-center gap-3">
              <span aria-hidden className="h-6 w-6 animate-spin rounded-full border-[3px] border-land border-t-ink" />
              Charging {method} {money(r.fare.amountMinor, r.fare.currency)}
            </li>
            <li className="flex items-center gap-3 text-muted">
              <span aria-hidden className="h-6 w-6 rounded-full border-2 border-line" />
              Receipt
            </li>
          </ol>
          <p className="text-[13.5px] text-muted">Your bank is reviewing the payment. This usually takes a second.</p>
        </div>
      );
    }
    if (r.payment.status === 'DECLINED') {
      return (
        <div className="kerb-step flex flex-col gap-5">
          <div className="rounded-2xl bg-bad-wash px-4 py-3">
            <p className="text-[16px] font-semibold text-bad">{declineReason(r.payment.declineCode)}</p>
            <p className="mt-1 text-[14px] text-ink">
              Your trip is complete, but {method} was declined for {money(r.fare.amountMinor, r.fare.currency)}. Pay with another card to settle it.
            </p>
          </div>
          <CardForm title="Pay with a card" submitLabel={`Pay ${money(r.fare.amountMinor, r.fare.currency)}`} busyLabel="Paying…" busy={busy === 'pay'} onSubmit={payWithCard} />
          <Attempts ride={r} />
        </div>
      );
    }
    return (
      <div className="kerb-step flex flex-col gap-5">
        <div>
          <p className="text-[14px] font-medium text-good">Paid · {method}</p>
          <h2 className="mt-1 font-display text-[44px] font-semibold leading-none tabular-nums">{money(r.fare.amountMinor, r.fare.currency)}</h2>
          <p className="mt-2 text-[15px] text-ink-2">Thanks for riding with {r.driver?.name ?? 'Kerb'}.</p>
        </div>
        <dl className="grid grid-cols-[1fr_auto] gap-y-2 border-t border-line pt-4 text-[14.5px]">
          <dt className="text-ink-2">Base fare</dt>
          <dd className="tabular-nums">{money(r.fare.baseMinor)}</dd>
          <dt className="text-ink-2">Distance · {distance(r.fare.distanceMeters)}</dt>
          <dd className="tabular-nums">{money(r.fare.distanceMinor)}</dd>
          <dt className="font-semibold">Total</dt>
          <dd className="font-semibold tabular-nums">{money(r.fare.amountMinor)}</dd>
        </dl>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-line pt-4 text-[14px]">
          <dt className="text-muted">Route</dt>
          <dd>
            {r.pickup.label} to {r.destination.label}
          </dd>
          <dt className="text-muted">Requested</dt>
          <dd>{clockTime(r.createdAt)}</dd>
          <dt className="text-muted">Trip ended</dt>
          <dd>{r.completedAt ? clockTime(r.completedAt) : '—'}</dd>
          <dt className="text-muted">Driver</dt>
          <dd>
            {r.driver?.name} · {r.driver?.vehicle} {r.driver?.plate && `· ${r.driver.plate}`}
          </dd>
          <dt className="text-muted">Paid</dt>
          <dd>{r.payment.paidAt ? clockTime(r.payment.paidAt) : '—'}</dd>
        </dl>
        <Attempts ride={r} />
        <button type="button" className="h-13 rounded-2xl bg-ink py-3.5 text-[16px] font-semibold text-white" onClick={finish}>
          Done
        </button>
      </div>
    );
  };

  return (
    <div className="relative h-full w-full">
      <CityMap
        focus={mapState.focus}
        pickup={mapState.pickup}
        destination={mapState.destination}
        route={mapState.route}
        progress={mapState.progress}
        car={mapState.car}
        nearby={shownRide ? [] : nearby?.drivers ?? []}
        searching={mapState.searching}
        insetLeft={isDesktop ? 456 : 0}
        insetBottom={isDesktop ? 0 : 500}
        label={shownRide ? `Map of your ride from ${shownRide.pickup.label} to ${shownRide.destination.label}` : `Map around ${pickup.label}`}
      />
      <section
        aria-label="Ride"
        className="absolute inset-x-0 bottom-0 max-h-[64%] overflow-y-auto rounded-t-[26px] bg-sheet px-5 pb-6 pt-5 shadow-[0_-8px_30px_rgba(34,38,43,0.16)] lg:inset-x-auto lg:bottom-auto lg:left-5 lg:top-[84px] lg:max-h-[calc(100%-104px)] lg:w-[420px] lg:rounded-[26px] lg:shadow-[0_10px_40px_rgba(34,38,43,0.18)]"
      >
        {notice && (
          <div role="alert" className="mb-4 rounded-xl bg-bad-wash px-3.5 py-2.5 text-[14px] text-bad">
            {notice}
          </div>
        )}
        {sheetBody()}
      </section>
    </div>
  );
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_008.8;
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function TripSummary({ ride }: { ride: Ride }) {
  return (
    <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-2xl bg-land px-4 py-3 text-[14px]">
      <dt aria-hidden className="h-2.5 w-2.5 rounded-full bg-ink" />
      <dd className="truncate">{ride.pickup.label ?? 'Pickup'}</dd>
      <dd className="row-span-2 text-right">
        <span className="block font-display text-[20px] font-semibold tabular-nums">{money(ride.fare.amountMinor, ride.fare.currency)}</span>
        <span className="block text-[12.5px] text-muted">{cardLabel(ride.payment.method)}</span>
      </dd>
      <dt aria-hidden className="h-2.5 w-2.5 bg-ink" />
      <dd className="truncate">
        {ride.destination.label ?? 'Destination'} · {distance(ride.fare.distanceMeters)}
      </dd>
    </dl>
  );
}

function Attempts({ ride }: { ride: Ride }) {
  if (ride.payment.attempts.length < 2) return null;
  return (
    <div className="border-t border-line pt-4">
      <p className="mb-2 text-[13px] font-medium text-muted">Payment attempts</p>
      <ol className="flex flex-col gap-1.5 text-[14px]">
        {ride.payment.attempts.map((a) => (
          <li key={a.attemptId} className="flex justify-between gap-3">
            <span>
              {cardLabel(a.method)} · {clockTime(a.settledAt)}
            </span>
            <span className={a.status === 'PAID' ? 'font-medium text-good' : 'text-bad'}>{a.status === 'PAID' ? 'Approved' : declineReason(a.declineCode)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
