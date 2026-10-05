import { z } from 'zod';
import { normalizeResponseContent } from './response-normalize';
import type { AnalysisResult } from '../../domain/ports/ai-brain.port';

// Gemma no soporta JSON mode → la salida puede venir con fences o prosa
// alrededor del JSON. Parseo defensivo, funciones puras.

const INTENTS = ['reply', 'ignore', 'complain', 'new_topic', 'error'] as const;

const toStringList = (v: unknown): string[] =>
  typeof v === 'string' || Array.isArray(v) ? normalizeResponseContent(v as string[]) : [];

const toBool = (v: unknown): unknown => {
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true' || v.trim() === '1';
  if (typeof v === 'number') return v !== 0;
  return v;
};

export const AnalysisResultSchema = z.object({
  intent: z.enum(INTENTS).catch('ignore'),
  response_content: z.preprocess(toStringList, z.array(z.string())),
  is_talking_to_me: z.preprocess(toBool, z.boolean().catch(false)),
  reply_to_message_id: z.preprocess(
    (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null),
    z.string().nullable(),
  ),
  ping_users: z.preprocess(toStringList, z.array(z.string())),
  thought_process: z.preprocess((v) => (v == null ? undefined : String(v)), z.string().optional()),
});

export function errorAnalysisResult(message: string): AnalysisResult {
  return {
    intent: 'error',
    response_content: [`Error crítico de IA: ${message}`],
    is_talking_to_me: false,
    ping_users: [],
    reply_to_message_id: null,
    thought_process: 'Error de generación',
  };
}

export function parseAnalysisJson(text: string): AnalysisResult {
  const raw = text.trim();
  const candidates = [raw];
  if (raw.startsWith('```')) {
    candidates.push(raw.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim());
  }
  const balanced = firstBalancedObject(raw);
  if (balanced && !candidates.includes(balanced)) candidates.push(balanced);
  for (const candidate of candidates) {
    try {
      // strictNullChecks:false hace z.infer todo-opcional → anclar el tipo del port.
      const parsed = AnalysisResultSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data as AnalysisResult;
    } catch {
      // siguiente candidato
    }
  }
  return errorAnalysisResult('salida ilegible del modelo');
}

// Primer objeto {...} balanceado, respetando strings con escapes.
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
