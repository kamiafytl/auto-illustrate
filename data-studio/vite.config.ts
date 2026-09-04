import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'
import { dataStorePlugin } from './server/plugins/dataStore'

// data-studio：临时「数据库浏览/编辑」工具，端口 3003（3001=webapp / 3002=studio-next，互不干扰）。
// 读同一份 ../data/；写回路径全部由 dataStorePlugin 的白名单+原子写+备份+字段保留 merge 守护。
export default defineConfig({
  plugins: [react(), dataStorePlugin()],
  server: {
    port: 3003,
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
