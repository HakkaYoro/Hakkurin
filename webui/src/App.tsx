import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { StatusInfo } from './types';
import { ToastContext } from './format';
import StatusHeader from './components/StatusHeader';
import ConfigTab from './components/ConfigTab';
import StatsDashboard from './components/StatsDashboard';
import MemoriesTab from './components/MemoriesTab';

type View = 'config' | 'stats' | 'memories';

const NAV: Array<[View, string]> = [
  ['config', 'Configuración'],
  ['stats', 'Stats'],
  ['memories', 'Memorias'],
];

export default function App() {
  const [view, setView] = useState<View>('config');
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const notify = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .status()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
    load();
    const t = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      <div className="shell">
        <StatusHeader status={status} />
        <nav className="nav" aria-label="Secciones">
          {NAV.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={view === v ? 'nav-btn active' : 'nav-btn'}
              aria-current={view === v ? 'page' : undefined}
              onClick={() => setView(v)}
            >
              {label}
            </button>
          ))}
        </nav>
        <main>
          {view === 'config' && <ConfigTab />}
          {view === 'stats' && <StatsDashboard />}
          {view === 'memories' && <MemoriesTab />}
        </main>
        {toast && (
          <div className={`toast ${toast.ok ? 'ok' : 'bad'}`} role="status">
            {toast.msg}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
