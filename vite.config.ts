import { defineConfig } from '@opencloud-eu/extension-sdk'

export default defineConfig({
  name: 'document-workflow',
  test: { include: ['tests/unit/**/*.spec.ts'], exclude: ['artifacts/**', 'draft-dist/**'] }
})
