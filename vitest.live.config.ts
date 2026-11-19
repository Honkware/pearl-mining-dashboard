import { defineConfig } from 'vitest/config';

// Needs PEARLD (a pearld binary) and PEARL_CHAIN (blocks saved as a JSON array of hex).
export default defineConfig({ test: { include: ['test-live/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 180_000 } });
