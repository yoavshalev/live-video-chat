import { defineConfig } from 'vitest/config'

// The suite deliberately targets src/shared/machine/ — a pure reducer with no
// Workers runtime dependency — so it runs in plain node in milliseconds. That is
// the whole reason the state machine was factored out of the Durable Object.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
