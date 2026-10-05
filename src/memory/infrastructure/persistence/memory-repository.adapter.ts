import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWrite } from '../../../common/util';
import { CryptoAdapter } from './crypto.adapter';
import { MemoryRepositoryPort } from '../../domain/ports/memory.ports';

// Memorias .enc (AES-256-GCM) + espejo plano de resúmenes.
// Ante archivo corrupto: borrar .enc + espejo .txt y devolver memoria vacía.

export const MEMORY_DIR = 'data/memory/users';
export const SUMMARY_DIR = 'data/memory/summaries';

@Injectable()
export class MemoryRepositoryAdapter extends MemoryRepositoryPort {
  private readonly logger = new Logger(MemoryRepositoryAdapter.name);

  constructor(private readonly crypto: CryptoAdapter) {
    super();
  }

  async init(): Promise<void> {
    await fs.mkdir(MEMORY_DIR, { recursive: true });
    await fs.mkdir(SUMMARY_DIR, { recursive: true });
  }

  async getMemory(user_id: string): Promise<any> {
    const filePath = this.filePath(user_id);
    try {
      const data = await fs.readFile(filePath);
      const decrypted = this.crypto.decrypt(data);
      return JSON.parse(decrypted);
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        this.logger.warn(`Error leyendo memoria de ${user_id}: ${e.message}. Eliminando archivo corrupto.`);
        try {
          await fs.unlink(filePath);
          const txtPath = path.join(SUMMARY_DIR, `${user_id}.txt`);
          await fs.unlink(txtPath).catch(() => {});
        } catch {}
      }
      return {};
    }
  }

  async saveMemory(user_id: string, memoryData: any): Promise<void> {
    const filePath = this.filePath(user_id);
    try {
      const json = JSON.stringify(memoryData);
      await atomicWrite(filePath, this.crypto.encrypt(json));
    } catch (e: any) {
      this.logger.error(`Error guardando memoria de ${user_id}: ${e.message}`);
    }
  }

  async saveSummaryPlaintext(user_id: string, summaryText: string): Promise<void> {
    const filePath = path.join(SUMMARY_DIR, `${user_id}.txt`);
    try {
      await atomicWrite(filePath, summaryText ?? '');
    } catch (e: any) {
      this.logger.warn(`Error guardando resumen plano de ${user_id}: ${e.message}`);
    }
  }

  /** Lista [{user_id, date}] por mtime desc; is_self lo marca MemoryService. */
  async listMemories(): Promise<{ user_id: string; date: string }[]> {
    const out: { user_id: string; date: string }[] = [];
    for (const filename of await this.listEncFiles()) {
      try {
        const stat = await fs.stat(path.join(MEMORY_DIR, filename));
        out.push({
          user_id: filename.replace(/\.enc$/, ''),
          date: new Date(stat.mtimeMs).toLocaleString('sv-SE'),
        });
      } catch {
        /* archivo desaparecido entre readdir y stat */
      }
    }
    out.sort((a, b) => (a.date < b.date ? 1 : -1));
    return out;
  }

  async listUserIds(): Promise<string[]> {
    const files = await this.listEncFiles();
    return files.map((f) => f.replace(/\.enc$/, ''));
  }

  async deleteMemory(user_id: string): Promise<void> {
    const encPath = this.filePath(user_id);
    const txtPath = path.join(SUMMARY_DIR, `${user_id}.txt`);
    try {
      await fs.unlink(encPath).catch(() => {});
      await fs.unlink(txtPath).catch(() => {});
    } catch (e) {
      this.logger.error(`Error borrando memoria de ${user_id}: ${(e as Error).message}`);
    }
  }

  async deleteAllMemories(): Promise<void> {
    try {
      const encFiles = await fs.readdir(MEMORY_DIR);
      for (const file of encFiles) {
        if (file.endsWith('.enc')) {
          await fs.unlink(path.join(MEMORY_DIR, file)).catch(() => {});
        }
      }
      const txtFiles = await fs.readdir(SUMMARY_DIR);
      for (const file of txtFiles) {
        if (file.endsWith('.txt')) {
          await fs.unlink(path.join(SUMMARY_DIR, file)).catch(() => {});
        }
      }
    } catch (e) {
      this.logger.error(`Error borrando todas las memorias: ${(e as Error).message}`);
    }
  }

  private async listEncFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(MEMORY_DIR);
      return files.filter((f) => f.endsWith('.enc'));
    } catch {
      return [];
    }
  }

  private filePath(user_id: string): string {
    return path.join(MEMORY_DIR, `${this.sanitizeUserId(user_id)}.enc`);
  }

  private sanitizeUserId(user_id: any): string {
    return String(user_id).trim();
  }
}
