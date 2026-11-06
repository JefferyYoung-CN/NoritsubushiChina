import { startVitest } from 'vitest/node';
import vue from '@vitejs/plugin-vue';
const vitest = await startVitest('test', [], {
  root: process.cwd(), config: false, watch: false, pool: 'threads',
  environment: 'jsdom', restoreMocks: true, passWithNoTests: false,
  include: ['test/**/*.test.ts'],
}, { plugins: [vue()] });
if (!vitest) { console.error('vitest did not start'); process.exitCode = 1; }
