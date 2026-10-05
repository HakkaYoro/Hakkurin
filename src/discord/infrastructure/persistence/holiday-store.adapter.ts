import { Injectable } from '@nestjs/common';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { HolidayStorePort } from '../../domain/ports/json-store.port';

const HOLIDAY_FILE = 'data/holidays.json';

@Injectable()
export class HolidayStoreAdapter extends HolidayStorePort {
  async load(): Promise<Record<string, boolean>> {
    try {
      if (!existsSync(HOLIDAY_FILE)) return {};
      return JSON.parse(await readFile(HOLIDAY_FILE, 'utf8'));
    } catch {
      return {};
    }
  }

  async save(data: Record<string, boolean>): Promise<void> {
    await mkdir(dirname(HOLIDAY_FILE), { recursive: true });
    await writeFile(HOLIDAY_FILE, JSON.stringify(data));
  }
}
