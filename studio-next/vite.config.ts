import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'
import { dataReadPlugin } from './server/plugins/dataRead'
import { translatePlugin } from './server/plugins/translate'

export default defineConfig({
  plugins: [react(), dataReadPlugin(), translatePlugin()],
  server: {
    port: 3002,
    open: false,
    watch: {
      ignored: ['**/data/**', '**/output/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
