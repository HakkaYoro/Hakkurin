import { Injectable, OnModuleInit } from '@nestjs/common';
import * as nunjucks from 'nunjucks';
import * as path from 'path';

// autoescape ON: el texto libre del modelo no debe inyectar HTML. __dirname (no cwd)
// para resolver igual en dev/jest/dist (nest-cli copia templates/ junto a view.service.js).
@Injectable()
export class ViewService implements OnModuleInit {
  private env!: nunjucks.Environment;

  onModuleInit(): void {
    this.env = nunjucks.configure(path.join(__dirname, 'templates'), {
      autoescape: true,
      noCache: true,
    });
  }

  render(name: string, ctx: Record<string, any>): string {
    return this.env.render(name, ctx);
  }
}
