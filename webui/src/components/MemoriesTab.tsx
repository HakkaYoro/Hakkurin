import { useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api';
import { ToastContext } from '../format';
import type { MemoryRow } from '../types';
import { Avatar } from './charts';

export default function MemoriesTab() {
  const notify = useContext(ToastContext);
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [detail, setDetail] = useState<{ id: string; name: string; content: string } | null>(null);

  const load = useCallback(
    () =>
      api
        .memories()
        .then((r) => setRows(r.memories))
        .catch(() => notify('No pude cargar las memorias', false)),
    [notify],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (!rows) return <p className="muted">Cargando memorias…</p>;

  const open = async (row: MemoryRow) => {
    try {
      const d = await api.memory(row.user_id);
      setDetail({ id: row.user_id, name: row.name, content: d.content });
    } catch {
      notify('No pude abrir la memoria', false);
    }
  };

  const del = async (row: MemoryRow) => {
    if (!window.confirm(`¿Borrar la memoria de ${row.name}?`)) return;
    try {
      await api.deleteMemory(row.user_id);
      notify('Memoria borrada');
      if (detail?.id === row.user_id) setDetail(null);
      load();
    } catch {
      notify('Error al borrar', false);
    }
  };

  const delAll = async () => {
    if (!window.confirm('¿Borrar TODAS las memorias? Esta acción no se puede deshacer.')) return;
    try {
      await api.deleteAllMemories();
      notify('Memorias borradas');
      setDetail(null);
      load();
    } catch {
      notify('Error al borrar', false);
    }
  };

  return (
    <div className="memories">
      <div className="toolbar">
        <span className="muted">
          {rows.length} memoria{rows.length === 1 ? '' : 's'}
        </span>
        {rows.length > 0 && (
          <button type="button" className="btn danger" onClick={delAll}>
            Borrar todas
          </button>
        )}
      </div>

      {rows.length === 0 && <p className="empty">No hay memorias aún.</p>}

      <ul className="memory-list">
        {rows.map((m) => (
          <li key={m.user_id} className={`card memory-item${m.is_self ? ' internal' : ''}`}>
            <Avatar url={m.avatarUrl} name={m.is_self ? '🧠' : m.name} />
            <span className="who">
              <span className="name">{m.name}</span>
              <span className="mid mono">{m.user_id}</span>
            </span>
            <span className="muted date">Actualizado {m.date}</span>
            <span className="actions">
              <button type="button" className="btn ghost sm" onClick={() => open(m)}>
                Ver
              </button>
              <button type="button" className="btn danger sm" onClick={() => del(m)}>
                Borrar
              </button>
            </span>
          </li>
        ))}
      </ul>

      {detail && (
        <section className="card memory-detail">
          <div className="detail-head">
            <h2>{detail.name}</h2>
            <button type="button" className="btn ghost sm" onClick={() => setDetail(null)}>
              Cerrar
            </button>
          </div>
          <p className="mid mono muted">{detail.id}</p>
          <div className="content">{detail.content}</div>
        </section>
      )}
    </div>
  );
}
