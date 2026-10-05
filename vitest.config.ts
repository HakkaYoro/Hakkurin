import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // globals:true para no tocar los 63 tests existentes; tipos vía tsconfig types.
    globals: true,
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/_setup.ts'],
  },
});
