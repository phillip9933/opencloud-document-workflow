import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { localAIPlugin } from './companion/preview-api.mjs'
import { draftPlugin } from './companion/draft-plugin.mjs'
export default defineConfig({ root: 'preview', publicDir: '../public', plugins: [vue(), localAIPlugin(), draftPlugin()], server: { host: '127.0.0.1', port: 5174, strictPort: true } })
