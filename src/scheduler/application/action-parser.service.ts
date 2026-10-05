// Las acciones programadas viven embebidas en el texto libre de la auto-memoria:
// un array JSON dentro de fences ```json``` (o suelto, formato libre de Gemma).
import { Injectable } from '@nestjs/common';

const DUE_WINDOW_S = 600;
const FENCED_RE = /```json\s*(\[.*?\])\s*```/gis;

export interface ScheduledAction {
  trigger_time: string;
  action_description: string;
  target_user_id: string | null;
  target_user_name: string | null;
}

@Injectable()
export class ActionParserService {
  /** Normaliza una acción cruda del JSON; null si faltan campos clave. */
  normalizeAction(action: any): ScheduledAction | null {
    if (!action || typeof action !== 'object') return null;
    const triggerTime = action.trigger_time;
    const actionDesc = action.action_description;
    if (!triggerTime || !actionDesc) return null;

    let targetUserId = action.target_user_id;
    if (targetUserId != null) {
      targetUserId = String(targetUserId).trim();
      if (!targetUserId) targetUserId = null;
    }
    const targetUserName =
      action.target_user_name != null ? String(action.target_user_name).trim() || null : null;

    return {
      trigger_time: String(triggerTime).trim(),
      action_description: String(actionDesc).trim(),
      target_user_id: targetUserId as string | null,
      target_user_name: targetUserName,
    };
  }

  /** Encuentra candidatos a array JSON: bloques ```json``` + arrays balanceados. */
  findJsonArrayCandidates(memoryText: string): string[] {
    const candidates: string[] = [];
    FENCED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FENCED_RE.exec(memoryText)) !== null) candidates.push(m[1]);

    const starts: number[] = [];
    for (let i = 0; i < memoryText.length; i++) if (memoryText[i] === '[') starts.push(i);
    for (const start of starts) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let idx = start; idx < memoryText.length; idx++) {
        const ch = memoryText[idx];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) {
            candidates.push(memoryText.slice(start, idx + 1));
            break;
          }
        }
      }
    }
    return candidates;
  }

  /** Bloque JSON "primario" (fenced o primer array parseable) con offsets para reescribir. */
  private findPrimaryJsonBlock(memoryText: string): { json: string; start: number; end: number } | null {
    FENCED_RE.lastIndex = 0;
    const fenced = FENCED_RE.exec(memoryText);
    if (fenced) {
      const json = fenced[1];
      const start = fenced.index + fenced[0].indexOf(json);
      return { json, start, end: start + json.length };
    }
    for (const candidate of this.findJsonArrayCandidates(memoryText)) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
          const start = memoryText.indexOf(candidate);
          if (start !== -1) return { json: candidate, start, end: start + candidate.length };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Fecha naive local (sin tz). */
  parseTriggerDate(triggerTimeStr: string): Date | null {
    // Normaliza separadores a ISO (YYYY/MM/DD → YYYY-MM-DD, ' ' → 'T'). new Date
    // exige ISO rellenado y Gemma (sin JSON mode) emite formato libre: rellenamos
    // a 2 dígitos.
    const norm = triggerTimeStr.trim().replace(/\//g, '-').replace(' ', 'T');
    const m = norm.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) {
      const pad = (x: string) => x.padStart(2, '0');
      const iso = `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${pad(m[5])}${m[6] != null ? ':' + pad(m[6]) : ''}`;
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(norm);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Clave de dedupe entre ejecuciones. */
  buildActionKey(action: any): string {
    const desc = String(action?.action_description ?? '').trim().toLowerCase();
    const trigger = String(action?.trigger_time ?? '').trim();
    const target = String(action?.target_user_id ?? '').trim();
    return `${trigger}|${target}|${desc}`;
  }

  parseScheduledActions(memoryText: string): ScheduledAction[] {
    if (!memoryText) return [];
    for (const jsonStr of this.findJsonArrayCandidates(memoryText)) {
      try {
        const actions = JSON.parse(jsonStr);
        if (!Array.isArray(actions)) continue;
        const normalized = actions
          .map((a) => this.normalizeAction(a))
          .filter((a): a is ScheduledAction => a !== null);
        return normalized;
      } catch {
        continue;
      }
    }
    return [];
  }

  /** Filtra acciones cuya ventana [0, 600]s comenzó. */
  checkDueActions(actions: ScheduledAction[]): ScheduledAction[] {
    const now = Date.now();
    const due: ScheduledAction[] = [];
    for (const action of actions) {
      if (!action.trigger_time) continue;
      const trigger = this.parseTriggerDate(action.trigger_time);
      if (!trigger) continue;
      const diff = (now - trigger.getTime()) / 1000;
      if (diff >= 0 && diff <= DUE_WINDOW_S) due.push(action);
    }
    return due;
  }

  /** Quita del texto las acciones ejecutadas sin romper el resto. */
  removeExecutedActionsFromMemory(memoryText: string, executedActions: any[]): string {
    if (!memoryText || !executedActions.length) return memoryText;
    const block = this.findPrimaryJsonBlock(memoryText);
    if (!block) return memoryText;
    let actions: any[];
    try {
      actions = JSON.parse(block.json);
    } catch {
      return memoryText;
    }
    if (!Array.isArray(actions)) return memoryText;

    const executedKeys = new Set(executedActions.filter((a) => a && typeof a === 'object').map((a) => this.buildActionKey(a)));
    if (!executedKeys.size) return memoryText;

    const remaining: ScheduledAction[] = [];
    for (const action of actions) {
      const safe = this.normalizeAction(action);
      if (!safe) continue;
      if (!executedKeys.has(this.buildActionKey(safe))) remaining.push(safe);
    }
    const newJson = JSON.stringify(remaining, null, 2);
    return memoryText.slice(0, block.start) + newJson + memoryText.slice(block.end);
  }
}
