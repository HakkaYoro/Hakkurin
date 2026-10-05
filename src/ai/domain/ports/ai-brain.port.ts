export interface InteractionContext {
  userText: string;
  userId: string;
  userName: string;
  contextMessages: string[]; // formato "Name (ID: 123): msg"
  isSessionActive: boolean;
  imageData?: Uint8Array | null; // Buffer es subtipo de Uint8Array
  imageMimeType?: string | null;
  activeUserIds?: string[] | null;
  isDm: boolean;
  currentPlaying?: string | null;
  urlContext?: string | null;
}

export interface AnalysisResult {
  intent: 'reply' | 'ignore' | 'complain' | 'new_topic' | 'error';
  // Invariante del port: el LLM puede devolver str o list; el mapper zod normaliza a list.
  response_content: string[];
  is_talking_to_me: boolean;
  thought_process?: string;
  reply_to_message_id?: string | null;
  ping_users: string[];
}

export abstract class AiBrain {
  abstract analyzeInteraction(ctx: InteractionContext): Promise<AnalysisResult>;
  abstract generateResponse(
    prompt: string,
    userContextId?: string,
    userName?: string,
  ): Promise<string | null>;
  abstract generateSummary(
    currentSummary: string,
    recentInteractions: string[],
    userId: string,
    modelName?: string,
  ): Promise<string | null>;
  abstract generateHolidayGreeting(userSummary: string, holidayName: string): Promise<string>;
  abstract testApiConnection(): Promise<boolean>;
  abstract reloadConfig(): Promise<void>;
}
