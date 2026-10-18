import { useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api';
import { fmtCompact, fmtInt, pct as pctDelta, ToastContext } from '../format';
import type { StatsData } from '../types';
import { AreaChart, Avatar, Donut, HBars, Heatmap, Spark } from './charts';

const PERIODS: Array<[number, string]> = [
  [1, '1 h'],
  [24, '1 d'],
  [168, '1 sem'],
  [720, '1 mes'],
];

function Kpi({
  label,
  value,
  sub,
  delta,
  spark,
}: {
  label: string;
  value: string;
  sub?: string;
  delta: number | null;
  spark: number[];
}) {
  return (
    <div className="card kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value num">{value}</span>
      <div className="kpi-foot">
        <span className="delta-wrap">
          {delta != null ? (
            <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(Math.round(delta))}%
            </span>
          ) : (
            <span className="delta none">—</span>
          )}
          <span className="muted">vs anterior</span>
        </span>
        <Spark data={spark} />
      </div>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

const sumCalls = (d: { aiCalls: Record<string, number> }) => Object.values(d.aiCalls).reduce((a, b) => a + b, 0);

export default function StatsDashboard() {
  const notify = useContext(ToastContext);
  const [hours, setHours] = useState(168);
  const [data, setData] = useState<StatsData | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(
    () =>
      api
        .stats(hours)
        .then((d) => {
          setData(d);
          setUpdatedAt(new Date());
        })
        .catch(() => {}),
    [hours],
  );

  useEffect(() => {
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!data) return <p className="muted">Cargando stats…</p>;

  const reset = async () => {
    if (!window.confirm('¿Borrar TODAS las estadísticas? Esta acción no se puede deshacer.')) return;
    try {
      await api.resetStats();
      notify('Estadísticas reiniciadas');
      await load();
    } catch {
      notify('Error al reiniciar las estadísticas', false);
    }
  };

  const t = data.totals;
  const cachePct = t.tokensIn > 0 ? (t.tokensCached * 100) / t.tokensIn : 0;
  const tokensTotal = t.tokensIn + t.tokensOut;
  const maxUser = data.users[0]?.messages ?? 1;
  const maxCmd = data.commands[0]?.count ?? 1;
  const periodLabel = PERIODS.find(([h]) => h === hours)?.[1] ?? '';

  return (
    <div className="stats">
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Periodo">
          {PERIODS.map(([h, label]) => (
            <button
              key={h}
              type="button"
              className={hours === h ? 'seg-btn active' : 'seg-btn'}
              aria-pressed={hours === h}
              onClick={() => setHours(h)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          {updatedAt && (
            <span className="muted">Actualizado {updatedAt.toLocaleTimeString('es')} · auto cada 30 s</span>
          )}
          <button type="button" className="btn danger" onClick={reset}>
            Reiniciar datos
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi
          label={`Mensajes · ${periodLabel}`}
          value={fmtInt(t.messages)}
          delta={pctDelta(t.messages, data.prev.messages)}
          spark={data.series.map((s) => s.messages)}
        />
        <Kpi
          label="Llamadas IA"
          value={fmtInt(t.aiCalls)}
          delta={pctDelta(t.aiCalls, data.prev.aiCalls)}
          spark={data.series.map((s) => s.aiCalls)}
        />
        <Kpi
          label="Tokens"
          value={fmtCompact(tokensTotal)}
          delta={pctDelta(tokensTotal, data.prev.tokensIn + data.prev.tokensOut)}
          spark={data.series.map((s) => s.tokens)}
          sub={`${Math.round(cachePct)}% del prompt cacheado`}
        />
        <Kpi
          label="Coste"
          value={t.cost > 0 ? `$${t.cost.toFixed(4)}` : '—'}
          delta={pctDelta(t.cost, data.prev.cost)}
          spark={data.series.map((s) => s.cost)}
          sub="créditos OpenRouter"
        />
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Actividad</h2>
          <AreaChart series={data.series} />
        </section>
        <section className="card">
          <h2>Eficiencia de caché</h2>
          <div className="cache-row">
            <Donut pctValue={cachePct} caption="cacheado" />
            <dl className="cache-facts">
              <div>
                <dt>Prompt (in)</dt>
                <dd className="num">{fmtInt(t.tokensIn)}</dd>
              </div>
              <div>
                <dt>Cacheado</dt>
                <dd className="num ok">{fmtInt(t.tokensCached)}</dd>
              </div>
              <div>
                <dt>Generado (out)</dt>
                <dd className="num">{fmtInt(t.tokensOut)}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>

      <section className="card">
        <h2>Actividad diaria (últimos 30 días)</h2>
        <Heatmap data={data.heatmap} />
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Quién usa más a Hakkurin</h2>
          {data.users.length ? (
            <ol className="leaderboard">
              {data.users.map((u, i) => (
                <li key={u.id}>
                  <span className="rank num">{i + 1}</span>
                  <Avatar url={u.avatarUrl} name={u.name} />
                  <span className="who">
                    <span className="name">{u.name}</span>
                    <span className="mid mono">{u.id}</span>
                  </span>
                  <div className="hbar-track">
                    <div className="hbar-fill" style={{ width: `${(u.messages / maxUser) * 100}%` }} />
                  </div>
                  <span className="num val">{fmtInt(u.messages)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty">Aún no hay mensajes registrados.</p>
          )}
        </section>
        <section className="card">
          <h2>Modelos usados</h2>
          {data.models.length ? (
            <HBars rows={data.models.slice(0, 8).map((m) => ({ label: m.model, value: m.calls }))} />
          ) : (
            <p className="empty">Sin llamadas IA en este periodo.</p>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Comandos</h2>
        {data.commands.length ? (
          <div className="cmds">
            {data.commands.map((c) => (
              <div className="cmd-row" key={c.command}>
                <code className="cmd">/{c.command}</code>
                <div className="hbar-track">
                  <div className="hbar-fill" style={{ width: `${(c.count / maxCmd) * 100}%` }} />
                </div>
                <span className="num val">{fmtInt(c.count)}</span>
                <span className="cmd-top">
                  {c.topUser && (
                    <>
                      <Avatar url={c.topUser.avatarUrl} name={c.topUser.name} size={22} />
                      <span className="name">{c.topUser.name}</span>
                      <span className="muted">×{fmtInt(c.topUser.count)}</span>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">Nadie ha usado comandos en este periodo.</p>
        )}
      </section>

      {data.daily.length > 0 && (
        <details className="card raw">
          <summary>Tabla diaria detallada</summary>
          <table className="stats-table">
            <thead>
              <tr>
                <th>Día</th>
                <th className="r">Mensajes</th>
                <th className="r">Llamadas IA</th>
                <th className="r">Tokens in</th>
                <th className="r">Tokens out</th>
                <th className="r">Cache</th>
                <th className="r">Coste</th>
              </tr>
            </thead>
            <tbody>
              {[...data.daily].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td className="r num">{fmtInt(d.messages)}</td>
                  <td
                    className="r num"
                    title={Object.entries(d.aiCalls).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                  >
                    {fmtInt(sumCalls(d))}
                  </td>
                  <td className="r num">{fmtInt(d.tokensIn)}</td>
                  <td className="r num">{fmtInt(d.tokensOut)}</td>
                  <td className="r num">{d.tokensIn > 0 ? `${Math.round((d.tokensCached * 100) / d.tokensIn)}%` : '—'}</td>
                  <td className="r num">{d.cost > 0 ? `$${d.cost.toFixed(4)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
