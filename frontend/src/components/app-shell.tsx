'use client';

import { useState } from 'react';
import Activity from './activity';
import Insights from './insights';
import LoadLab from './load-lab';
import RideTab from './ride-tab';

type Tab = 'ride' | 'activity' | 'insights' | 'load';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'ride', label: 'Ride' },
  { id: 'activity', label: 'Trips' },
  { id: 'insights', label: 'Insights' },
  { id: 'load', label: 'Load lab' },
];

export default function AppShell() {
  const [tab, setTab] = useState<Tab>('ride');
  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <header
        className={`absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 px-4 py-4 lg:px-6 ${
          tab === 'ride' ? 'pointer-events-none' : 'border-b border-line bg-paper/95 backdrop-blur'
        }`}
      >
        <p className="pointer-events-auto font-display text-[28px] font-bold leading-none tracking-tight">
          kerb<span className="text-amber-deep">.</span>
        </p>
        <nav aria-label="Main" className="pointer-events-auto rounded-full bg-white/95 p-1 shadow-[0_2px_14px_rgba(34,38,43,0.14)] backdrop-blur">
          <ul className="flex">
            {TABS.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-current={tab === t.id ? 'page' : undefined}
                  className={`rounded-full px-3.5 py-2 text-[14px] font-semibold transition-colors sm:px-4 ${tab === t.id ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink'}`}
                >
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className={tab === 'ride' ? 'h-full' : 'h-full overflow-y-auto'}>
        {tab === 'ride' && <RideTab />}
        {tab === 'activity' && <Activity onOpenRide={() => setTab('ride')} />}
        {tab === 'insights' && <Insights />}
        {tab === 'load' && <LoadLab />}
      </main>
    </div>
  );
}
