export interface BotStatus {
  connected: boolean;
  uptimeS: number;
  readySince: string | null;
  lastDisconnectAt: string | null;
}

export interface MemberInfo {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface StatusInfo {
  bot: BotStatus;
  provider: 'gemini' | 'openrouter';
  chatModel: string;
  memoryModel: string;
  reasoningEffort: string;
  geminiKeysCount: number;
}

export interface AppConfig {
  bot_name: string;
  bot_contact: string;
  system_prompt: string;
  reply_probability: number;
  developer_id: string;
  allowed_channels: string;
  ai_provider: 'gemini' | 'openrouter';
  openrouter_chat_model: string;
  openrouter_memory_model: string;
  openrouter_reasoning_effort: string;
  max_history_messages: number;
  deafen_move_enabled: boolean;
  deafen_move_channel_id: string;
  deafen_move_minutes: number;
  navidrome_base_url: string;
  navidrome_external_url: string;
  navidrome_username: string;
  ytdl_sidecar_url: string;
  prompt_hakka: string;
  prompt_rules: string;
  prompt_holiday: string;
  prompt_self_summary: string;
  prompt_user_profile: string;
  prompt_translate: string;
  prompt_reminder: string;
  prompt_accion: string;
  has_bot_token: boolean;
  has_navidrome_password: boolean;
  has_openrouter_key: boolean;
  has_webui_token: boolean;
  gemini_keys_count: number;
}

export type ConfigDraft = AppConfig & {
  gemini_keys: string;
  openrouter_api_key: string;
  bot_token: string;
  navidrome_password: string;
  webui_token: string;
};

export interface Totals {
  messages: number;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  cost: number;
}

export interface StatsData {
  totals: Totals;
  prev: Totals;
  series: Array<{ key: string; messages: number; aiCalls: number; tokens: number; cost: number }>;
  daily: Array<{
    day: string;
    messages: number;
    aiCalls: Record<string, number>;
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
    cost: number;
  }>;
  heatmap: Array<{ day: string; messages: number }>;
  models: Array<{ model: string; calls: number }>;
  users: Array<MemberInfo & { messages: number }>;
  commands: Array<{ command: string; count: number; topUser: (MemberInfo & { count: number }) | null }>;
}

export interface MemoryRow {
  user_id: string;
  date: string;
  is_self: boolean;
  name: string;
  avatarUrl: string | null;
}
