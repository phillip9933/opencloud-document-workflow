import { buildInventory } from './build-inventory.ts'
import { defineConfig } from '@opencloud-eu/extension-sdk'

export default defineConfig({
  plugins: [buildInventory('dist')],
  name: 'document-workflow',
  test: { include: ['tests/unit/**/*.spec.ts'], exclude: ['artifacts/**', 'draft-dist/**'] }
})
