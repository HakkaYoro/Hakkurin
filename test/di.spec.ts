import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { INJECTABLE_WATERMARK, MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';

// Nest instanciaría sin dependencias una clase proveída sin @Injectable()
// (no emite design:paramtypes) y el bootstrap no falla: rompe en runtime.
const visited = new Set<Function>();

function checkProvider(cls: Function, moduleName: string): void {
  if (visited.has(cls)) return;
  visited.add(cls);
  if (!Reflect.getMetadata(INJECTABLE_WATERMARK, cls)) {
    throw new Error(
      `${cls.name} proveído en ${moduleName} sin @Injectable(): Nest lo instancia sin argumentos`,
    );
  }
}

function walk(moduleCls: Function): void {
  if (visited.has(moduleCls)) return;
  visited.add(moduleCls);
  for (const imp of Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleCls) ?? []) walk(imp);
  const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, moduleCls) ?? [];
  for (const p of providers) {
    if (typeof p === 'function') checkProvider(p, moduleCls.name);
    else if (typeof (p as any)?.useExisting === 'function') checkProvider((p as any).useExisting, moduleCls.name);
    else if (typeof (p as any)?.useClass === 'function') checkProvider((p as any).useClass, moduleCls.name);
  }
}

describe('grafo DI', () => {
  it('toda clase proveída en un @Module lleva @Injectable()', () => {
    walk(AppModule);
    expect(visited.size).toBeGreaterThan(10);
  });
});
