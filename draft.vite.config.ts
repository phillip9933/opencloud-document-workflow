import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  root: 'preview',
  publicDir: '../public',
  plugins: [vue()],
  base: './',
  build: { outDir: '../draft-dist', emptyOutDir: true }
})
