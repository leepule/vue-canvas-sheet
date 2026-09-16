import { defineConfig, mergeConfig } from 'vitest/config'
import webConfig from './vite.config.js'

export default mergeConfig(webConfig, defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.js'],
    server: {
      deps: {
        inline: ['@lucide/vue']
      }
    }
  }
}))
