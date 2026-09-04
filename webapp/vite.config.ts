import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { dataApiPlugin } from './server/plugins/dataApi'
import { dataReadPlugin } from './server/plugins/dataRead'
import { comfyuiBridgePlugin } from './server/plugins/comfyuiBridge'
import { gitSyncPlugin } from './server/plugins/gitSync'
import { charactersPlugin } from './server/plugins/characters'
import { naiPlugin } from './server/plugins/nai'
import { ratingPlugin } from './server/plugins/rating'
import { translatePlugin } from './server/plugins/translate'
import { danbooruPlugin } from './server/plugins/danbooru'

// 各 middleware 已拆分到 server/plugins/*.ts（只搬家，行为不变）。
// __dirname 原指向 webapp 根，拆分后由本文件显式传入各 plugin 的 rootDir 参数保持基准一致。
export default defineConfig({
  plugins: [react(), tailwindcss(), dataReadPlugin(), translatePlugin(), danbooruPlugin(__dirname), dataApiPlugin(__dirname), comfyuiBridgePlugin(__dirname), gitSyncPlugin(__dirname), naiPlugin(__dirname), charactersPlugin(__dirname), ratingPlugin(__dirname)],
  server: {
    host: true,   // 绑定 0.0.0.0，WSL2 → Windows 浏览器可直接访问
    port: 3001,
    open: false,
    watch: {
      ignored: ['**/public/data/**', '**/data/**', '**/output/**', '**/public/images/**', '**/public/lazydog-thumbs/**']
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  publicDir: 'public',
  // 2026-06-19 懒狗库已并入主 webapp(App.tsx 的「散图库」tab)，撤销原 lazydog.html 双入口，单入口 index.html。
  // 旧 lazydog.html 保留为重定向→/?tab=lazydog(HTA 启动器 tools/Owner-Launcher.hta:216 仍指它)。
})
