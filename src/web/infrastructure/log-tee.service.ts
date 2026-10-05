import { ConsoleLogger, Injectable } from '@nestjs/common';

// Ring buffer en memoria: el bot vive en Docker (stdout del contenedor inaccesible
// desde el proceso) y la WebUI expone GET /logs para descargarlo.
const MAX_LINES = 2000;

@Injectable()
export class LogTeeService extends ConsoleLogger {
  private readonly buffer: string[] = [];

  private tee(level: string, message: any, context?: string): void {
    const msg = typeof message === 'string' ? message : String(message);
    this.buffer.push(`${new Date().toISOString()} ${level} ${context ? `[${context}] ` : ''}${msg}`);
    if (this.buffer.length > MAX_LINES) this.buffer.shift();
  }

  log(message: any, context?: string): void {
    this.tee('LOG', message, context);
    super.log(message, context);
  }

  warn(message: any, context?: string): void {
    this.tee('WARN', message, context);
    super.warn(message, context);
  }

  error(message: any, stackOrContext?: string, context?: string): void {
    this.tee('ERROR', message, context);
    super.error(message, stackOrContext, context);
  }

  debug(message: any, context?: string): void {
    this.tee('DEBUG', message, context);
    super.debug(message, context);
  }

  verbose(message: any, context?: string): void {
    this.tee('VERB', message, context);
    super.verbose(message, context);
  }

  text(): string {
    return this.buffer.join('\n') + '\n';
  }
}
