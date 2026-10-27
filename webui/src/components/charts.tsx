import { useState } from 'react';
import { fmtInt } from '../format';

export function Spark({ data, width = 96, height = 30 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return <svg className="spark" width={width} height={height} aria-hidden="true" />;
  const max = Math.max(...data, 1);
  const pts = data
    .map((v, i) => `${((i / (data.length - 1)) * width).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const W = 640;
const H = 190;
const PAD = { t: 14, r: 10, b: 24, l: 10 };

// Claves de serie: 'YYYY-MM-DDTHH' (horaria) o 'YYYY-MM-DD' (diaria).
function seriesLabel(key: string, long = false): string {
  if (key.includes('T')) {
    const day = new Date(`${key.slice(0, 10)}T00:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short' });
    return long ? `${day} ${key.slice(11, 13)}:00` : `${key.slice(11, 13)}h`;
  }
  return new Date(`${key}T00:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

export function AreaChart({ series }: { series: Array<{ key: string; messages: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  if (series.length < 2) return <p className="empty">Sin datos suficientes para la serie.</p>;
  const max = Math.max(...series.map((d) => d.messages), 1);
  const n = series.length;
  const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / (n - 1);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const line = series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.messages).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${H - PAD.b} L${x(0).toFixed(1)},${H - PAD.b} Z`;

  return (
    <div className="chart-wrap">
      <span className="chart-max num">{fmtInt(max)}</span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Mensajes en el periodo, máximo ${fmtInt(max)}`}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const vx = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((vx - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * (H - PAD.t - PAD.b)} y2={PAD.t + f * (H - PAD.t - PAD.b)} className="grid" />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className="axis" />
        <path d={area} className="area" />
        <path d={line} className="stroke" />
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="cursor" />
            <circle cx={x(hover)} cy={y(series[hover].messages)} r="4" className="point" />
          </g>
        )}
        <text x={PAD.l} y={H - 6} className="tick">{seriesLabel(series[0].key)}</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" className="tick">{seriesLabel(series[n - 1].key)}</text>
      </svg>
      {hover != null && (
        <div
          className="chart-tip"
          style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(series[hover].messages) / H) * 100}%` }}
        >
          <strong className="num">{fmtInt(series[hover].messages)}</strong> · {seriesLabel(series[hover].key, true)}
        </div>
      )}
    </div>
  );
}

export function Donut({ pctValue, caption }: { pctValue: number; caption: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const filled = (Math.min(Math.max(pctValue, 0), 100) / 100) * c;
  return (
    <svg className="donut" viewBox="0 0 132 132" role="img" aria-label={`${caption}: ${Math.round(pctValue)}%`}>
      <circle cx="66" cy="66" r={r} className="donut-bg" strokeWidth="14" fill="none" />
      <circle
        cx="66"
        cy="66"
        r={r}
        className="donut-fg"
        strokeWidth="14"
        fill="none"
        strokeDasharray={`${filled.toFixed(1)} ${c.toFixed(1)}`}
        strokeLinecap="round"
        transform="rotate(-90 66 66)"
      />
      <text x="66" y="63" textAnchor="middle" className="donut-num">
        {Math.round(pctValue)}%
      </text>
      <text x="66" y="83" textAnchor="middle" className="donut-caption">
        {caption}
      </text>
    </svg>
  );
}

const HEAT_WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const HEAT_MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Rejilla estilo GitHub: columnas = semanas, filas = días, labels de mes y
// día de semana. La intensidad usa cuartiles de los días CON actividad para
// que un día pico no aplane el resto.
export function Heatmap({ data }: { data: Array<{ day: string; messages: number }> }) {
  if (data.length === 0) return <p className="empty">Sin datos aún.</p>;
  const nonzero = data.map((d) => d.messages).filter((v) => v > 0).sort((a, b) => a - b);
  const quart = (p: number) => nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * p))] ?? 0;
  const [t1, t2, t3] = [quart(0.25), quart(0.5), quart(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
  const offset = new Date(`${data[0].day}T00:00:00`).getDay();
  const cells: Array<{ day: string; messages: number } | null> = [
    ...Array<null>(offset).fill(null),
    ...data,
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = cells.length / 7;
  const monthOfCol: string[] = [];
  let lastMonth = -1;
  for (let col = 0; col < weeks; col++) {
    const first = cells[col * 7] ?? cells.slice(col * 7, col * 7 + 7).find((c) => c);
    const m = first ? new Date(`${first.day}T00:00:00`).getMonth() : -1;
    monthOfCol.push(m >= 0 && m !== lastMonth ? HEAT_MONTHS[m] : '');
    if (m >= 0) lastMonth = m;
  }
  return (
    <div>
      <div className="heat-months" aria-hidden="true">
        {monthOfCol.map((label, col) => (
          <span key={col} className="heat-month">{label}</span>
        ))}
      </div>
      <div className="heat-body">
        <div className="heat-days" aria-hidden="true">
          {HEAT_WD.map((d, i) => (
            <span key={d}>{i === 1 || i === 3 || i === 5 ? d : ''}</span>
          ))}
        </div>
        <div className="heatmap" role="img" aria-label={`Mensajes por día, últimos ${data.length} días`}>
          {Array.from({ length: weeks }, (_, col) => (
            <div className="heat-col" key={col}>
              {cells.slice(col * 7, col * 7 + 7).map((cell, row) =>
                cell ? (
                  <div
                    key={row}
                    className={`heat-cell l${level(cell.messages)}`}
                    title={`${cell.day}: ${fmtInt(cell.messages)} mensajes`}
                  />
                ) : (
                  <div key={row} className="heat-cell empty" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="heat-legend" aria-hidden="true">
        <span>Menos</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <div key={l} className={`heat-cell l${l}`} />
        ))}
        <span>Más</span>
      </div>
    </div>
  );
}

export function HBars({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar-row" key={r.label}>
          <span className="hbar-label mono" title={r.label}>
            {r.label}
          </span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="hbar-value num">{fmtInt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function Avatar({ url, name, size = 34 }: { url: string | null; name: string; size?: number }) {
  if (url) {
    return <img className="avatar" src={url} alt="" width={size} height={size} loading="lazy" />;
  }
  return (
    <span className="avatar fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {(name[0] ?? '?').toUpperCase()}
    </span>
  );
}
