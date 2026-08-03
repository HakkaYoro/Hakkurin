import { Injectable, OnModuleInit } from '@nestjs/common';
import * as nunjucks from 'nunjucks';
import * as path from 'path';

// Server-rendered con nunjucks (puerto de web/app.py Jinja2Templates). autoescape ON
// para que el contenido de memorias (texto libre del modelo) no inyecte HTML.
// __dirname (no process.cwd()) para que resuelva igual en dev, jest y build.
// ponytail: para `nest build` (tsc a dist/), copiar templates/ al lado de view.service.js
// vía nest-cli assets — anotar en el Dockerfile de Phase 7.
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
