// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Plugin } from 'vite'

export function buildInventory(directory: string): Plugin {
  return {
    name: 'document-workflow-package-inventory',
    apply: 'build',
    enforce: 'post',
    writeBundle(_, bundle) {
      mkdirSync('artifacts', { recursive: true })
      writeFileSync(`artifacts/${directory}-files.json`, JSON.stringify(Object.keys(bundle)))
    }
  }
}
