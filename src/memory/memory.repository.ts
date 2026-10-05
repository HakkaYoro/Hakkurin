import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CryptoService } from './crypto.service';

// Adaptador de persistencia cifrada (hexagonal): sólo sabe leer/escribir/borrar
// memorias .enc (AES-256-GCM vía CryptoService) y el espejo plano de resúmenes.
// No conoce la política de dominio (normalización de esquema, cola temporal,
// self-memory): eso vive en MemoryService, que consume este adaptador.

export const MEMORY_DIR = 'data/memory/users';
export const SUMMARY_DIR = 'data/memory/summaries';

@Injectable()
export class MemoryRepository {
  private readonly logger = new Logger(MemoryRepository.name);

  constructor(private readonly crypto: CryptoService) {}

  // get_memory (memory_manager.py:118-132). Devuelve el JSON crudo descifrado;
  // la normalización de esquema la aplica el dominio. Ante archivo corrupto lo
  // elimina (.enc + espejo .txt) y devuelve {} (→ memoria vacía al normalizar).
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
        } catch (unlinkErr) {
           // Ignorar si no se puede borrar
        }
      }
      return {};
    }
  }

  // save_memory (memory_manager.py:134-143). Recibe la memoria YA normalizada
  // por el dominio; aquí sólo serializa, cifra y escribe atómicamente.
  async saveMemory(user_id: string, memoryData: any): Promise<void> {
    const filePath = this.filePath(user_id);
    try {
      const json = JSON.stringify(memoryData);
      await this.atomicWriteBytes(filePath, this.crypto.encrypt(json));
    } catch (e: any) {
      this.logger.error(`Error guardando memoria de ${user_id}: ${e.message}`);
    }
  }

  // Espejo plano del resumen para el WebUI.
  async saveSummaryPlaintext(user_id: string, summaryText: string): Promise<void> {
    const filePath = path.join(SUMMARY_DIR, `${user_id}.txt`);
    try {
      await this.atomicWriteText(filePath, summaryText ?? '');
    } catch (e: any) {
      this.logger.warn(`Error guardando resumen plano de ${user_id}: ${e.message}`);
    }
  }

  /** Lista cruda [{user_id, date}] por mtime desc; el dominio marca is_self. */
  async listMemories(): Promise<{ user_id: string; date: string }[]> {
    let files: string[];
    try {
      files = await fs.readdir(MEMORY_DIR);
    } catch {
      return [];
    }
    const out: { user_id: string; date: string }[] = [];
    const pad = (n: number) => String(n).padStart(2, '0');
    for (const filename of files) {
      if (!filename.endsWith('.enc')) continue;
      const user_id = filename.replace(/\.enc$/, '');
      try {
        const d = new Date((await fs.stat(path.join(MEMORY_DIR, filename))).mtimeMs);
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        out.push({ user_id, date });
      } catch {
        /* archivo desaparecido entre readdir y stat */
      }
    }
    out.sort((a, b) => (a.date < b.date ? 1 : -1));
    return out;
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

  private filePath(user_id: string): string {
    return path.join(MEMORY_DIR, `${this.sanitizeUserId(user_id)}.enc`);
  }

  private sanitizeUserId(user_id: any): string {
    return String(user_id).trim();
  }

  private async atomicWriteBytes(filePath: string, data: Buffer): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  }

  private async atomicWriteText(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
  }
}
