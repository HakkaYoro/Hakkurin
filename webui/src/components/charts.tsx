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

export function AreaChart({ days }: { days: Array<{ day: string; messages: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  if (days.length < 2) return <p className="empty">Sin datos suficientes.</p>;
  const max = Math.max(...days.map((d) => d.messages), 1);
  const n = days.length;
  const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / (n - 1);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.messages).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${H - PAD.b} L${x(0).toFixed(1)},${H - PAD.b} Z`;
  const fmtDay = (day: string) =>
    new Date(`${day}T00:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short' });

  return (
    <div className="chart-wrap">
      <span className="chart-max num">{fmtInt(max)}</span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Mensajes por día, máximo ${fmtInt(max)}`}
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
            <circle cx={x(hover)} cy={y(days[hover].messages)} r="4" className="point" />
          </g>
        )}
        <text x={PAD.l} y={H - 6} className="tick">{fmtDay(days[0].day)}</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" className="tick">{fmtDay(days[n - 1].day)}</text>
      </svg>
      {hover != null && (
        <div
          className="chart-tip"
          style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(days[hover].messages) / H) * 100}%` }}
        >
          <strong className="num">{fmtInt(days[hover].messages)}</strong> · {days[hover].day}
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

export function Heatmap({ data }: { data: Array<{ day: string; messages: number }> }) {
  if (data.length === 0) return <p className="empty">Sin datos aún.</p>;
  const max = Math.max(...data.map((d) => d.messages), 1);
  const level = (v: number) => (v <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const offset = new Date(`${data[0].day}T00:00:00`).getDay();
  const cells: Array<{ day: string; messages: number } | null> = [
    ...Array<null>(offset).fill(null),
    ...data,
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return (
    <div>
      <div className="heatmap" role="img" aria-label={`Mensajes por día, últimos ${data.length} días`}>
        {Array.from({ length: cells.length / 7 }, (_, col) => (
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
