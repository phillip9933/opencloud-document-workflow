// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const root = '/install-history',
  operation = process.argv[2],
  lock = root + '/deployment-lock'
try {
  if (operation === 'acquire') {
    await mkdir(lock, { mode: 0o700 })
    const token = randomUUID()
    await writeFile(lock + '/owner', token, { mode: 0o600, flag: 'wx' })
    console.log(token)
  } else if (operation === 'release') {
    if ((await readFile(lock + '/owner', 'utf8')) !== process.argv[3])
      throw Error('Deployment lock changed')
    await rm(lock, { recursive: true })
  } else if (operation === 'read') {
    try {
      process.stdout.write(await readFile(root + '/active-plan.json', 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  } else if (operation === 'commit') {
    let text = ''
    for await (const part of process.stdin) {
      text += part
      if (text.length > 65536) throw Error('Plan too large')
    }
    const plan = JSON.parse(text)
    if (
      !/^document-workflow-[a-f0-9]{10}$/.test(plan.name) ||
      !/^sha256:[a-f0-9]{64}$/.test(plan.services?.companion?.image)
    )
      throw Error('Invalid deployment plan')
    const path = root + '/plan-' + randomUUID() + '.json'
    await writeFile(path, text, { mode: 0o600, flag: 'wx' })
    await rename(path, root + '/active-plan.json')
  } else throw Error('Unknown plan operation')
} catch (e) {
  console.error(
    operation === 'acquire'
      ? 'Another installation is active or interrupted; its lock is retained'
      : e.message
  )
  process.exitCode = 1
}
