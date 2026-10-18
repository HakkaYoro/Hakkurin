import { createContext } from 'react';

export const ToastContext = createContext<(msg: string, ok?: boolean) => void>(() => {});

const intFmt = new Intl.NumberFormat('es');
const compactFmt = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 });

export function fmtInt(n: number): string {
  return intFmt.format(n);
}

export function fmtCompact(n: number): string {
  return compactFmt.format(n);
}

export function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function pct(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}
