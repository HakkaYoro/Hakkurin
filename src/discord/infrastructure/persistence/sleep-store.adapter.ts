import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { SleepStorePort, StatusMessages } from '../../domain/ports/json-store.port';

const STATUS_FILE = 'data/status_messages.json';

@Injectable()
export class SleepStoreAdapter extends SleepStorePort {
  private readonly logger = new Logger(SleepStoreAdapter.name);

  async loadStatusMessages(): Promise<StatusMessages> {
    try {
      return JSON.parse(await readFile(STATUS_FILE, 'utf-8')) as StatusMessages;
    } catch {
      this.logger.warn(`No pude leer ${STATUS_FILE}, usando frases por defecto.`);
      return {};
    }
  }
}
