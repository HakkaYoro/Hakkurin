import type { StatusInfo } from '../types';
import { fmtUptime } from '../format';

export default function StatusHeader({ status }: { status: StatusInfo | null }) {
  if (!status) {
    return (
      <header className="card status-card">
        <span className="muted">Cargando estado…</span>
      </header>
    );
  }
  const { bot, provider } = status;
  const EFFORT_LABEL: Record<string, string> = {
    default: '',
    none: 'apagado',
    low: 'bajo',
    medium: 'medio',
    high: 'alto',
  };
  let models: string;
  if (provider === 'openrouter') {
    const base = [status.chatModel, status.memoryModel].filter(Boolean).join(' · ') || 'sin configurar';
    const effort = EFFORT_LABEL[status.reasoningEffort] ?? '';
    models = effort ? `${base} · pensamiento ${effort}` : base;
  } else {
    models = `${status.geminiKeysCount} key(s) Gemini`;
  }
  return (
    <header className="card status-card">
      <div className="status-line">
        <span className={`dot ${bot.connected ? 'ok' : 'bad'}`} aria-hidden="true" />
        <strong>{bot.connected ? 'Conectado a Discord' : 'Desconectado'}</strong>
        <span className="muted">· uptime {fmtUptime(bot.uptimeS)}</span>
      </div>
      <div className="status-grid">
        <div>
          <span className="label">Proveedor IA</span>
          <span>{provider === 'openrouter' ? 'OpenRouter' : 'Gemini'}</span>
        </div>
        <div>
          <span className="label">Modelos</span>
          <span className="mono">{models}</span>
        </div>
        <div>
          <span className="label">Última desconexión</span>
          <span>
            {bot.lastDisconnectAt ? new Date(bot.lastDisconnectAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
          </span>
        </div>
      </div>
    </header>
  );
}
