import { buildInventory } from './build-inventory.ts'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  root: 'preview',
  publicDir: '../public',
  plugins: [vue(), buildInventory('draft-dist')],
  base: './',
  build: { outDir: '../draft-dist', emptyOutDir: true }
})
