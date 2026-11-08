import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // No test reaches the network: non-loopback fetch and sockets are
    // refused, and a test that tried fails (tests/setup/network-guard.ts).
    setupFiles: ['tests/setup/network-guard.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/types/**'],
      reporter: ['text', 'html'],
    },
  },
})
