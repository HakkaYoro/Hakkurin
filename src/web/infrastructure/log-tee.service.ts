import { ConsoleLogger, Injectable } from '@nestjs/common';

// Ring buffer en memoria: el bot vive en Docker (stdout del contenedor inaccesible
// desde el proceso) y la WebUI expone GET /logs para descargarlo.
const MAX_LINES = 2000;

const strCtx = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

@Injectable()
export class LogTeeService extends ConsoleLogger {
  private readonly buffer: string[] = [];

  private tee(level: string, message: any, context?: string): void {
    const msg = typeof message === 'string' ? message : String(message);
    this.buffer.push(`${new Date().toISOString()} ${level} ${context ? `[${context}] ` : ''}${msg}`);
    if (this.buffer.length > MAX_LINES) this.buffer.shift();
  }

  // Forward con rest: super.log(msg, undefined) explícito hace que ConsoleLogger
  // imprima [msg, undefined] como DOS mensajes (la línea "undefined" del stdout).
  log(message: any, ...rest: any[]): void {
    this.tee('LOG', message, strCtx(rest[0]));
    super.log(message, ...rest);
  }

  warn(message: any, ...rest: any[]): void {
    this.tee('WARN', message, strCtx(rest[0]));
    super.warn(message, ...rest);
  }

  error(message: any, ...rest: any[]): void {
    this.tee('ERROR', message, strCtx(rest[1]));
    super.error(message, ...rest);
  }

  debug(message: any, ...rest: any[]): void {
    this.tee('DEBUG', message, strCtx(rest[0]));
    super.debug(message, ...rest);
  }

  verbose(message: any, ...rest: any[]): void {
    this.tee('VERB', message, strCtx(rest[0]));
    super.verbose(message, ...rest);
  }

  text(): string {
    return this.buffer.join('\n') + '\n';
  }
}
