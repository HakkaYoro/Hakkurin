import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

// Puerto de core/config_manager.py. Store JSON en data/config.json (gitignored),
// escritura atómica (temp + rename) — arregla la deuda no-atómica de :35-37.
// Las credenciales Navidrome (antes hardcoded en bot/navidrome_client.py:9-13)
// viven aquí también. Singleton vía NestJS DI (ConfigModule @Global).

export const CONFIG_FILE = 'data/config.json';

export interface HakkurinConfig {
  bot_token: string;
  gemini_keys: string[];
  bot_name: string;
  allowed_channels: string[];
  system_prompt: string;
  reply_probability: number;
  developer_id: string;
  // Claves añadidas en el port (no en defaults originales de Python):
  nanogpt_api_key?: string; // legacy, se ignora en el port Gemini-only — se mantiene solo para migrar el config existente
  // Navidrome (antes hardcoded en navidrome_client.py:9-13):
  navidrome_base_url?: string;
  navidrome_external_url?: string;
  navidrome_username?: string;
  navidrome_password?: string;
  // WebUI:
  webui_token?: string;
  debug_dm?: boolean;
  // Sidecar yt-dlp:
  ytdl_sidecar_url?: string;
  [key: string]: any;
}

const DEFAULTS: HakkurinConfig = {
  bot_token: '',
  gemini_keys: [],
  bot_name: 'Hakkurin',
  allowed_channels: [],
  system_prompt:
    'Eres Hakkurin, una chica usuaria de Discord con una personalidad e-girl, otaku y fujoshi. Te gusta el anime, el manga y usar emoticonos. Eres sarcástica pero amigable si te tratan bien. Si te ignoran, dejas de hablar. Tienes memoria de con quién hablas.',
  reply_probability: 0.125,
  developer_id: '321799812595056645',
};

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);
  private config: HakkurinConfig = { ...DEFAULTS };
  private loadPromise: Promise<void> | null = null;

  constructor() {
    this.loadPromise = this.load();
  }

  // Reentrante: el constructor y llamadas externas comparten el mismo load.
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
      this.config = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        await this.save(); // escribe defaults si no existe
      } else {
        this.logger.error(`Error leyendo ${CONFIG_FILE}: ${e.message}`);
      }
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.config, null, 4), 'utf-8');
    await fs.rename(tmp, CONFIG_FILE); // atómico
  }

  get<T = any>(key: string, defaultValue: T = undefined as any): T {
    return (this.config[key] as T) ?? defaultValue;
  }

  getAll(): HakkurinConfig {
    return this.config;
  }

  async set(key: string, value: any): Promise<void> {
    this.config[key] = value;
    await this.save();
  }
}
