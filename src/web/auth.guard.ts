import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '../common/config.service';

// Auth opt-in: si NO hay webui_token en config, se permite (el bind localhost es la
// protección por defecto). Si lo hay, exige HTTP Basic con password = token — el
// navegador gestiona el diálogo 401 nativo, sin dependencias ni página de login.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = this.config.get<string>('webui_token');
    if (!token) return true;

    const req = ctx.switchToHttp().getRequest();
    const auth: string = req?.headers?.authorization || '';
    const m = /^Basic\s+(.+)$/i.exec(auth);
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const pass = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
      if (pass === token) return true;
    }
    ctx.switchToHttp().getResponse()?.setHeader?.('WWW-Authenticate', 'Basic realm="hakkurin"');
    throw new UnauthorizedException();
  }
}
