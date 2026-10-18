import { useContext, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { api } from '../api';
import { ToastContext } from '../format';
import type { ConfigDraft } from '../types';

const SECTIONS = [
  ['general', 'General'],
  ['ia', 'IA'],
  ['voz', 'Voz y música'],
  ['navidrome', 'Navidrome'],
  ['peligro', 'Peligro'],
] as const;

type Section = (typeof SECTIONS)[number][0];
type Secret = 'gemini_keys' | 'openrouter_api_key' | 'bot_token' | 'navidrome_password' | 'webui_token';

interface SectionProps {
  form: ConfigDraft;
  set: (key: keyof ConfigDraft, value: string | number | boolean) => void;
  setSecret: (key: Secret) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

export default function ConfigTab() {
  const notify = useContext(ToastContext);
  const [form, setForm] = useState<ConfigDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<Section>('general');

  useEffect(() => {
    api
      .config()
      .then((c) => {
        document.title = c.bot_name || 'Hakkurin';
        setForm({ ...c, gemini_keys: '', openrouter_api_key: '', bot_token: '', navidrome_password: '', webui_token: '' });
      })
      .catch(() => notify('No pude cargar la configuración', false));
  }, [notify]);

  if (!form) return <p className="muted">Cargando configuración…</p>;

  const set = (key: keyof ConfigDraft, value: string | number | boolean) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));
  const setSecret = (key: Secret) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key, e.target.value);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.saveConfig(form);
      const c = await api.config();
      setForm({ ...c, gemini_keys: '', openrouter_api_key: '', bot_token: '', navidrome_password: '', webui_token: '' });
      notify('Configuración guardada');
    } catch {
      notify('Error al guardar', false);
    } finally {
      setSaving(false);
    }
  };

  const props: SectionProps = { form, set, setSecret };

  return (
    <form onSubmit={save}>
      <div className="seg subnav" role="group" aria-label="Secciones de configuración">
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={section === id ? 'seg-btn active' : 'seg-btn'}
            aria-pressed={section === id}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {section === 'general' && <GeneralSection {...props} />}
      {section === 'ia' && <IaSection {...props} />}
      {section === 'voz' && <VozSection {...props} />}
      {section === 'navidrome' && <NavidromeSection {...props} />}
      {section === 'peligro' && <PeligroSection {...props} restart={restart} />}

      <div className="save-bar">
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );

  async function restart() {
    if (!window.confirm('¿Reiniciar el bot? Se cerrarán conexiones de voz y sesiones activas.')) return;
    try {
      await api.restart();
      notify('El bot se está reiniciando…', false);
    } catch {
      notify('Error al reiniciar', false);
    }
  }
}

function GeneralSection({ form, set, setSecret }: SectionProps) {
  return (
    <section className="card">
      <h2>General</h2>
      <div className="form-group">
        <label htmlFor="f-bot-name">Nombre del bot</label>
        <input id="f-bot-name" value={form.bot_name} onChange={(e) => set('bot_name', e.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor="f-prompt">Prompt de sistema</label>
        <textarea id="f-prompt" rows={5} value={form.system_prompt} onChange={(e) => set('system_prompt', e.target.value)} />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="f-dev">ID del desarrollador</label>
          <input id="f-dev" className="mono" value={form.developer_id} onChange={(e) => set('developer_id', e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="f-token">
            Bot token{' '}
            {form.has_bot_token && <span className="badge">configurado</span>}
          </label>
          <input
            id="f-token"
            type="password"
            placeholder="(dejar vacío para mantener el actual)"
            value={form.bot_token}
            onChange={setSecret('bot_token')}
            autoComplete="new-password"
          />
        </div>
      </div>
      <div className="form-group">
        <label htmlFor="f-channels">Canales permitidos</label>
        <textarea
          id="f-channels"
          rows={3}
          className="mono"
          value={form.allowed_channels}
          onChange={(e) => set('allowed_channels', e.target.value)}
          placeholder="Un ID de canal por línea (vacío = todos)"
        />
      </div>
    </section>
  );
}

function IaSection({ form, set, setSecret }: SectionProps) {
  return (
    <section className="card">
      <h2>Inteligencia artificial</h2>
      <div className="form-group">
        <label htmlFor="f-provider">Proveedor IA</label>
        <select id="f-provider" value={form.ai_provider} onChange={(e) => set('ai_provider', e.target.value)}>
          <option value="gemini">Gemini</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </div>

      {form.ai_provider === 'gemini' ? (
        <div className="form-group">
          <label htmlFor="f-gemini">
            Gemini API Keys <span className="badge">{form.gemini_keys_count} configurada(s)</span>
          </label>
          <textarea
            id="f-gemini"
            rows={3}
            className="mono"
            value={form.gemini_keys}
            onChange={setSecret('gemini_keys')}
            placeholder={form.gemini_keys_count ? '(dejar vacío para mantener las actuales)' : 'Una key por línea'}
          />
        </div>
      ) : (
        <>
          <div className="form-group">
            <label htmlFor="f-or-key">
              OpenRouter API Key{' '}
              {form.has_openrouter_key && <span className="badge">configurada</span>}
            </label>
            <input
              id="f-or-key"
              type="password"
              placeholder="(dejar vacío para mantener la actual)"
              value={form.openrouter_api_key}
              onChange={setSecret('openrouter_api_key')}
              autoComplete="new-password"
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="f-or-chat">Modelo de chat</label>
              <input
                id="f-or-chat"
                className="mono"
                placeholder="p. ej. deepseek/deepseek-v3.1"
                value={form.openrouter_chat_model}
                onChange={(e) => set('openrouter_chat_model', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="f-or-mem">Modelo de memoria</label>
              <input
                id="f-or-mem"
                className="mono"
                placeholder="(vacío = usa el modelo de chat)"
                value={form.openrouter_memory_model}
                onChange={(e) => set('openrouter_memory_model', e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="f-history">Máximo de mensajes de contexto</label>
          <input
            id="f-history"
            type="number"
            min={1}
            value={form.max_history_messages}
            onChange={(e) => set('max_history_messages', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
        <div className="form-group">
          <label htmlFor="f-reply">Probabilidad de respuesta (0–1)</label>
          {/* step="any": 0.125 no es múltiplo de 0.01 y bloquearía el submit */}
          <input
            id="f-reply"
            type="number"
            step="any"
            min="0"
            max="1"
            value={form.reply_probability}
            onChange={(e) => set('reply_probability', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
      </div>
    </section>
  );
}

function VozSection({ form, set }: SectionProps) {
  return (
    <section className="card">
      <h2>Voz y música</h2>
      <div className="form-check">
        <input id="f-deafen" type="checkbox" checked={form.deafen_move_enabled} onChange={(e) => set('deafen_move_enabled', e.target.checked)} />
        <label htmlFor="f-deafen">Mover autoensordecidos a un canal específico</label>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="f-deafen-ch">Canal de destino (ID)</label>
          <input
            id="f-deafen-ch"
            className="mono"
            value={form.deafen_move_channel_id}
            onChange={(e) => set('deafen_move_channel_id', e.target.value)}
            disabled={!form.deafen_move_enabled}
          />
        </div>
        <div className="form-group">
          <label htmlFor="f-deafen-min">Minutos de gracia</label>
          <input
            id="f-deafen-min"
            type="number"
            min={0}
            value={form.deafen_move_minutes}
            onChange={(e) => set('deafen_move_minutes', e.target.value === '' ? '' : Number(e.target.value))}
            disabled={!form.deafen_move_enabled}
          />
        </div>
      </div>
      <div className="form-group">
        <label htmlFor="f-sidecar">Sidecar yt-dlp (URL)</label>
        <input id="f-sidecar" className="mono" value={form.ytdl_sidecar_url} onChange={(e) => set('ytdl_sidecar_url', e.target.value)} />
      </div>
    </section>
  );
}

function NavidromeSection({ form, set, setSecret }: SectionProps) {
  return (
    <section className="card">
      <h2>Navidrome</h2>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="f-nd-base">URL base</label>
          <input id="f-nd-base" className="mono" value={form.navidrome_base_url} onChange={(e) => set('navidrome_base_url', e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="f-nd-ext">URL externa</label>
          <input id="f-nd-ext" className="mono" value={form.navidrome_external_url} onChange={(e) => set('navidrome_external_url', e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="f-nd-user">Usuario</label>
          <input id="f-nd-user" value={form.navidrome_username} onChange={(e) => set('navidrome_username', e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="f-nd-pass">
            Contraseña{' '}
            {form.has_navidrome_password && <span className="badge">configurada</span>}
          </label>
          <input
            id="f-nd-pass"
            type="password"
            placeholder="(dejar vacío para mantener la actual)"
            value={form.navidrome_password}
            onChange={setSecret('navidrome_password')}
            autoComplete="new-password"
          />
        </div>
      </div>
    </section>
  );
}

function PeligroSection({ form, setSecret, restart }: SectionProps & { restart: () => Promise<void> }) {
  return (
    <section className="card danger-card">
      <h2>Peligro</h2>
      <div className="form-group">
        <label htmlFor="f-webui-token">
          Token del WebUI{' '}
          {form.has_webui_token && <span className="badge">configurado</span>}
        </label>
        <input
          id="f-webui-token"
          type="password"
          placeholder="(dejar vacío para mantener el actual)"
          value={form.webui_token}
          onChange={setSecret('webui_token')}
          autoComplete="new-password"
        />
        <p className="hint">Con token configurado, el WebUI pide autenticación HTTP Basic (cualquier usuario, esa contraseña).</p>
      </div>
      <div className="danger-actions">
        <button type="button" className="btn danger" onClick={restart}>
          Reiniciar bot
        </button>
        <a className="btn ghost" href="/logs">
          Exportar logs
        </a>
      </div>
    </section>
  );
}
