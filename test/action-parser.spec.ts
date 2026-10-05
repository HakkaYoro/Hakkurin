import { ActionParserService } from '../src/discord/application/action-parser.service';

// Parsea un array JSON (fenced o balanceado suelto) dentro del texto libre de la
// auto-memoria, filtra la ventana "due" de 10min y reescribe el bloque sin las
// ejecutadas. Cubrimos esos caminos + dedupe.

function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

describe('ActionParserService', () => {
  const parser = new ActionParserService();

  describe('parseScheduledActions', () => {
    it('extrae acciones de un bloque ```json``` dentro de texto libre', () => {
      const mem = `Resumen del bot...\n\`\`\`json\n[\n  {"trigger_time":"2026-01-01T00:00","action_description":"Saludar","target_user_id":"123"}\n]\n\`\`\`\nMás texto.`;
      const out = parser.parseScheduledActions(mem);
      expect(out).toHaveLength(1);
      expect(out[0].action_description).toBe('Saludar');
      expect(out[0].target_user_id).toBe('123');
    });

    it('cae a array balanceado suelto cuando no hay fence', () => {
      const mem = `Notas varias [{"trigger_time":"2026-01-01T00:00","action_description":"X"}] fin.`;
      expect(parser.parseScheduledActions(mem)).toHaveLength(1);
    });

    it('descarta acciones sin trigger_time o action_description', () => {
      const mem = '```json\n[{"trigger_time":"2026-01-01T00:00"},{"action_description":"solo desc"}]\n```';
      expect(parser.parseScheduledActions(mem)).toHaveLength(0);
    });

    it('memoria vacía → []', () => {
      expect(parser.parseScheduledActions('')).toEqual([]);
    });
  });

  describe('buildActionKey (dedupe)', () => {
    it('es insensible a mayúsculas en la descripción', () => {
      const a = parser.buildActionKey({ action_description: 'SALUDAR', trigger_time: 't', target_user_id: '1' });
      const b = parser.buildActionKey({ action_description: 'saludar', trigger_time: 't', target_user_id: '1' });
      expect(a).toBe(b);
    });

    it('diferente target → diferente key', () => {
      const a = parser.buildActionKey({ action_description: 'x', trigger_time: 't', target_user_id: '1' });
      const b = parser.buildActionKey({ action_description: 'x', trigger_time: 't', target_user_id: '2' });
      expect(a).not.toBe(b);
    });
  });

  describe('checkDueActions', () => {
    const mk = (trigger: string) => ({ trigger_time: trigger, action_description: 'd', target_user_id: null, target_user_name: null });

    it('ahora mismo y hace 5min → due', () => {
      const now = new Date();
      const fiveAgo = new Date(Date.now() - 5 * 60 * 1000);
      const due = parser.checkDueActions([mk(fmtLocal(now)), mk(fmtLocal(fiveAgo))]);
      expect(due).toHaveLength(2);
    });

    it('futura o >10min pasada → no due', () => {
      const inFive = new Date(Date.now() + 5 * 60 * 1000);
      const twentyAgo = new Date(Date.now() - 20 * 60 * 1000);
      const due = parser.checkDueActions([mk(fmtLocal(inFive)), mk(fmtLocal(twentyAgo))]);
      expect(due).toHaveLength(0);
    });

    it('fecha no zero-padded (estilo strptime libre) → se parsea y entra en ventana', () => {
      // Gemma sin JSON mode puede emitir "2026-8-3 0:1"; strptime lo aceptaba, new Date no.
      const d = new Date(); // mismo instante → diff≈0 → entra en ventana.
      const unpadded = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
      expect(parser.parseTriggerDate(unpadded)).not.toBeNull();
      const due = parser.checkDueActions([{ trigger_time: unpadded, action_description: 'x', target_user_id: null, target_user_name: null }]);
      expect(due).toHaveLength(1);
    });
  });

  describe('removeExecutedActionsFromMemory', () => {
    it('elimina solo las ejecutadas y preserva el texto alrededor', () => {
      const mem =
        `Intro del bot.\n\`\`\`json\n` +
        `[\n  {"trigger_time":"2026-01-01T00:00","action_description":"A","target_user_id":"1"},\n` +
        `  {"trigger_time":"2026-01-01T00:00","action_description":"B","target_user_id":"2"}\n]\n\`\`\`\noutro.`;
      const out = parser.removeExecutedActionsFromMemory(mem, [
        { trigger_time: '2026-01-01T00:00', action_description: 'A', target_user_id: '1', target_user_name: null },
      ]);
      expect(out).toContain('Intro del bot.');
      expect(out).toContain('outro.');
      const remaining = parser.parseScheduledActions(out);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].action_description).toBe('B');
    });

    it('sin ejecutadas → texto intacto', () => {
      const mem = '```json\n[{"trigger_time":"2026-01-01T00:00","action_description":"A"}]\n```';
      expect(parser.removeExecutedActionsFromMemory(mem, [])).toBe(mem);
    });
  });
});
