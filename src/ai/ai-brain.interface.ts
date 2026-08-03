// Contrato del cerebro de IA. La capa Discord depende SOLO de esta interfaz.
// (docs/03-nestjs-port-plan.md §4). El provider de Gemini debe reproducir las
// formas de retorno del Python exactamente.

export interface InteractionContext {
  userText: string;
  userId: string;
  userName: string;
  contextMessages: string[]; // channel_history, "Name (ID: 123): msg"
  isSessionActive: boolean;
  imageData?: Buffer | Uint8Array | null;
  imageMimeType?: string | null;
  activeUserIds?: string[] | null;
  isDm: boolean;
  currentPlaying?: string | null;
  urlContext?: string | null;
}

export interface AnalysisResult {
  intent: 'reply' | 'ignore' | 'complain' | 'new_topic' | 'error';
  response_content: string[]; // Python devuelve LIST (a veces str; el pipeline normaliza)
  is_talking_to_me: boolean;
  thought_process?: string;
  reply_to_message_id?: string | null;
  ping_users: string[];
}

export interface AiBrain {
  analyzeInteraction(ctx: InteractionContext): Promise<AnalysisResult>;
  generateResponse(
    prompt: string,
    userContextId?: string,
    userName?: string,
  ): Promise<string | null>;
  generateSummary(
    currentSummary: string,
    recentInteractions: string[],
    userId: string,
    modelName?: string,
  ): Promise<string | null>;
  generateHolidayGreeting(userSummary: string, holidayName: string): Promise<string>;
  testApiConnection(): Promise<boolean>;
  reloadConfig(): Promise<void>;
}
