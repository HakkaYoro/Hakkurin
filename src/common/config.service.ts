import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWrite } from './util';

export const CONFIG_FILE = 'data/config.json';

export interface HakkurinConfig {
  bot_token: string;
  gemini_keys: string[];
  bot_name: string;
  allowed_channels: string[];
  system_prompt: string;
  reply_probability: number;
  developer_id: string;
  navidrome_base_url?: string;
  navidrome_external_url?: string;
  navidrome_username?: string;
  navidrome_password?: string;
  webui_token?: string;
  debug_dm?: boolean;
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
    await atomicWrite(CONFIG_FILE, JSON.stringify(this.config, null, 4));
  }

  get<T = any>(key: string, defaultValue: T = undefined as any): T {
    return (this.config[key] as T) ?? defaultValue;
  }

  /** URL base del sidecar yt-dlp. Env manda sobre config: en compose lo fija
   *  YTDL_SIDECAR_URL (docker-compose.yml) — un config vacío dejaba el default
   *  localhost:7654, que dentro del contenedor del bot es ECONNREFUSED permanente. */
  sidecarUrl(): string {
    return process.env.YTDL_SIDECAR_URL || this.get<string>('ytdl_sidecar_url', 'http://localhost:7654');
  }

  getAll(): HakkurinConfig {
    return this.config;
  }

  async set(key: string, value: any): Promise<void> {
    this.config[key] = value;
    await this.save();
  }
}
