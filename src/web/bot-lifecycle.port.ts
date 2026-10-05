// Puerto de ciclo de vida del bot que consume la WebUI (hexagonal): el controlador
// no conoce DiscordService, sólo esta interfaz. El adaptador real se cablea en
// WebModule con useExisting.
export const BOT_LIFECYCLE = 'BotLifecycle';

export interface BotLifecycle {
  forceShutdownAndSummarize(): Promise<void>;
  restart(): Promise<void>;
}
