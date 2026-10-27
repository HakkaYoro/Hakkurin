// El shape JSON persistido no cambia (compat con las .enc ya escritas).

export interface UserProfile {
  name: string;
  personality_traits: string[];
  likes: string[];
  dislikes: string[];
  speaking_style: string;
}

export interface UserMemory {
  profile: UserProfile;
  interaction_count: number;
  last_topics: string[];
  notes: string;
  summary: string;
  history_buffer: string[];
  last_summary_time: number;
  last_channel_id: number | null;
}

function createEmptyMemory(): UserMemory {
  return {
    profile: { name: '', personality_traits: [], likes: [], dislikes: [], speaking_style: '' },
    interaction_count: 0,
    last_topics: [],
    notes: 'Usuario nuevo.',
    summary: '',
    history_buffer: [],
    last_summary_time: 0,
    last_channel_id: null,
  };
}

function isStrIntFloat(v: any): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';
}

function normalizeMemorySchema(raw: any): UserMemory {
  const mem = !raw || typeof raw !== 'object' ? {} : raw;
  const normalized = createEmptyMemory();
  Object.assign(normalized, mem);

  const profileDefaults = createEmptyMemory().profile;
  const profile = mem.profile && typeof mem.profile === 'object' ? mem.profile : {};
  const safeProfile: UserProfile = { ...profileDefaults };
  for (const key of Object.keys(profileDefaults) as (keyof UserProfile)[]) {
    const value = profile[key] ?? profileDefaults[key];
    if (key === 'personality_traits' || key === 'likes' || key === 'dislikes') {
      safeProfile[key] = Array.isArray(value)
        ? value.filter((v: any) => isStrIntFloat(v)).map((v: any) => String(v))
        : [];
    } else {
      safeProfile[key] = value != null ? String(value) : profileDefaults[key];
    }
  }
  normalized.profile = safeProfile;

  normalized.interaction_count =
    typeof normalized.interaction_count === 'number' && Number.isInteger(normalized.interaction_count)
      ? normalized.interaction_count
      : 0;

  normalized.last_topics = Array.isArray(normalized.last_topics) ? normalized.last_topics : [];
  if (typeof normalized.notes !== 'string') normalized.notes = 'Usuario nuevo.';
  if (typeof normalized.summary !== 'string') normalized.summary = '';
  if (Array.isArray(normalized.history_buffer)) {
    normalized.history_buffer = normalized.history_buffer
      .filter((i: any) => isStrIntFloat(i))
      .map((i: any) => String(i));
  } else {
    normalized.history_buffer = [];
  }

  const lst = Number(normalized.last_summary_time);
  normalized.last_summary_time = Number.isFinite(lst) ? lst : 0;

  const lc = normalized.last_channel_id;
  const lcNum = Number(lc);
  normalized.last_channel_id =
    lc != null && Number.isInteger(lcNum) && Number.isFinite(lcNum) ? lcNum : null;

  return normalized;
}

const SUMMARY_TRIGGER_SECONDS = 1200;
const SUMMARY_TRIGGER_INTERACTIONS = 20;
// El cerebro (self) se refresca mucho más rápido que los perfiles de usuario.
const SELF_TRIGGER_INTERACTIONS = 5;

export class UserMemoryAggregate {
  private constructor(private readonly mem: UserMemory) {}

  static fromRaw(raw: any): UserMemoryAggregate {
    return new UserMemoryAggregate(normalizeMemorySchema(raw));
  }

  get raw(): UserMemory {
    return this.mem;
  }

  /** El texto llega ya validado (no vacío). */
  appendInteraction(text: string, isSelf = false): boolean {
    this.mem.history_buffer.push(text);
    this.mem.interaction_count += 1;
    return this.needsSummary(Date.now() / 1000, isSelf);
  }

  needsSummary(now: number, isSelf = false): boolean {
    const trigger = isSelf ? SELF_TRIGGER_INTERACTIONS : SUMMARY_TRIGGER_INTERACTIONS;
    if (this.mem.history_buffer.length >= trigger) return true;
    // Sin resumen previo (last_summary_time=0) no hay base de tiempo: si no, la
    // 1ª interacción de cada memoria nueva dispararía resumen inmediato.
    if (!this.mem.last_summary_time) return false;
    return this.mem.history_buffer.length > 0 && now - this.mem.last_summary_time > SUMMARY_TRIGGER_SECONDS;
  }

  /**
   * Escribe summary y last_summary_time; recorta del buffer el prefijo
   * procesado. Prefijo ajeno (no coincide) → conservar el buffer completo.
   * processedInteractions null → vacía el buffer.
   */
  applySummary(summary: string | null, processedInteractions?: string[] | null): void {
    this.mem.summary = summary != null ? String(summary) : '';

    const currentBuffer = [...this.mem.history_buffer];
    if (processedInteractions == null) {
      this.mem.history_buffer = [];
    } else {
      const processed = processedInteractions.map(String);
      if (processed.length > 0 && processed.every((v, i) => currentBuffer[i] === v)) {
        this.mem.history_buffer = currentBuffer.slice(processed.length);
      }
    }

    this.mem.last_summary_time = Date.now() / 1000;
  }

  touchChannel(channelId: any): void {
    const num = Number(channelId);
    this.mem.last_channel_id = Number.isInteger(num) && Number.isFinite(num) ? num : null;
  }
}
