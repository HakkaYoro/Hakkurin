import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { EncryptorPort } from '../../domain/ports/memory.ports';

// Formato del .enc: iv(12) || authTag(16) || ciphertext, todo Buffer.
// La clave vive en data/memory/secret.key (base64 de 32 bytes), 0600, gitignored.

export const KEY_FILE = 'data/memory/secret.key';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

@Injectable()
export class CryptoAdapter extends EncryptorPort implements OnModuleInit {
  private readonly logger = new Logger(CryptoAdapter.name);
  private key!: Buffer;
  private ready: Promise<void>;

  constructor() {
    super();
    this.ready = this.loadOrCreateKey();
  }

  async onModuleInit(): Promise<void> {
    await this.ready;
  }

  private async loadOrCreateKey(): Promise<void> {
    try {
      const b64 = await fs.readFile(KEY_FILE, 'utf-8');
      this.key = Buffer.from(b64.trim(), 'base64');
      if (this.key.length !== 32) throw new Error(`clave de ${this.key.length} bytes, esperaba 32`);
      return;
    } catch (e: any) {
      if (e.code !== 'ENOENT') this.logger.warn(`Clave ilegible, regenerando: ${e.message}`);
    }
    this.key = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(KEY_FILE), { recursive: true });
    await fs.writeFile(KEY_FILE, this.key.toString('base64'), { mode: 0o600 });
  }

  encrypt(plaintext: string): Buffer {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
  }

  decrypt(data: Buffer): string {
    if (data.length < IV_LEN + TAG_LEN) throw new Error('ciphertext demasiado corto');
    const iv = data.subarray(0, IV_LEN);
    const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = data.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
  }
}
