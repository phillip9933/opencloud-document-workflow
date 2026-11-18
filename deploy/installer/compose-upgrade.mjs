// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { inventory } from './web-assets.mjs'

function parts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw Error('Compose updates require a stable release version')
  return version.split('.').map(BigInt)
}

export async function composeUpgrade({ apps, release, database, backups, stoppedCheckpoint }) {
  const current = JSON.parse(
    await readFile(join(apps, 'document-workflow', 'manifest.json'), 'utf8')
  )
  const from = parts(current.version)
  const to = parts(release.version)
  const change = to.findIndex((value, index) => value !== from[index])
  if (release.appId !== 'document-workflow') throw Error('Unexpected Compose release app')
  if (change === -1) {
    const files = await inventory(join(apps, release.appId))
    if (
      release.files &&
      Object.keys(files).length === Object.keys(release.files).length &&
      Object.entries(files).every(([path, hash]) => release.files[path] === hash)
    )
      return { state: 'unchanged', version: release.version }
  }
  if (change >= 0 && to[change] < from[change])
    throw Error('Compose cannot downgrade Document Workflow')
  const checkpoint = await stoppedCheckpoint(database, backups)
  if (checkpoint.state !== 'verified')
    throw Error('Existing workflow journal could not be verified')
  return { state: 'checkpointed', from: current.version, version: release.version }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { stoppedCheckpoint } = await import('/app/companion/stopped-checkpoint.mjs')
    const release = JSON.parse(await readFile('/distribution/release.json', 'utf8'))
    console.log(
      JSON.stringify(
        await composeUpgrade({
          release,
          apps: '/installed-web-apps',
          database: '/state/workflow.sqlite3',
          backups: '/backups/install-checkpoints',
          stoppedCheckpoint
        })
      )
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
