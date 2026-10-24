import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Request logs are noise in a green run; the logging tests capture console themselves.
    silent: true,
    // The suite stubs global fetch; nothing may reach a real provider.
    restoreMocks: true,
    unstubGlobals: true,
  },
});
