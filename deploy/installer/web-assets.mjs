// SPDX-License-Identifier: AGPL-3.0-only
// Runs only in the network-isolated, one-shot asset installer, never the companion.
import {
  lstat,
  readFile,
  writeFile,
  readdir,
  mkdir,
  cp,
  rename,
  rm,
  realpath,
  chown,
  chmod
} from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const marker = '.workflow-release.json'
async function exists(path) {
  try {
    return await lstat(path)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}
async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
async function save(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
async function copyConfiguration(from, to) {
  const path = join(from, 'config.json'),
    st = await exists(path)
  if (!st) return
  if (st.isSymbolicLink() || !st.isFile()) throw Error('Unsafe operator config')
  await cp(path, join(to, 'config.json'), { force: true })
  await chown(join(to, 'config.json'), st.uid, st.gid)
  await chmod(join(to, 'config.json'), st.mode & 0o777)
}
export async function inventory(root) {
  const files = {}
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name),
        name = relative(root, path)
      if (entry.isSymbolicLink()) throw Error('Web assets contain a symbolic link')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        if (name !== marker && name !== 'config.json') files[name] = hash(await readFile(path))
      } else throw Error('Unsupported web asset')
    }
  }
  await visit(root)
  return files
}
function same(a, b) {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())
}
async function match(root, known) {
  const st = await exists(root)
  if (!st) return null
  if (!st.isDirectory() || st.isSymbolicLink())
    throw Error('App directory must be a real directory')
  const manifest = await json(join(root, 'manifest.json')),
    release = known.find((r) => r.version === manifest.version)
  if (!release || !same(await inventory(root), release.files))
    throw Error('Existing app assets differ from a known release; no files were replaced')
  for (const name of [marker, 'config.json']) {
    const file = await exists(join(root, name))
    if (file && (!file.isFile() || file.isSymbolicLink()))
      throw Error('Unsafe app configuration or marker')
  }
  return release
}
export async function webAssets({ apps, history, source, release, known = [] }, action = 'check') {
  apps = await realpath(apps)
  history = await realpath(history)
  source = await realpath(source)
  if (
    [apps, history, source].some((a, i, all) =>
      all.some((b, j) => i !== j && (a === b || a.startsWith(b + '/')))
    )
  )
    throw Error('Installer paths must be separate')
  if (
    release.appId !== 'document-workflow' ||
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    !same(await inventory(source), release.files)
  )
    throw Error('Packaged web assets failed verification')
  if ((await json(join(source, 'manifest.json'))).version !== release.version)
    throw Error('Native version mismatch')
  const target = join(apps, release.appId),
    all = [release, ...known],
    lock = join(history, 'asset-lock')
  await mkdir(lock, { mode: 0o700 })
  try {
    const unresolved = (await readdir(history)).filter((n) => /^intent-[a-f0-9-]+\.json$/.test(n))
    if (unresolved.length)
      throw Error(
        'An interrupted asset install needs recovery; retained files and intent are unchanged'
      )
    if (action === 'check') {
      const current = await match(target, all)
      return { state: 'checked', current: current?.version ?? null, version: release.version }
    }
    if (action === 'rollback') {
      const pointer = await json(join(history, 'last-install.json')),
        receipt = await json(join(history, pointer.receipt))
      if (!/^[a-f0-9-]+$/.test(receipt.id) || receipt.version !== release.version)
        throw Error('Rollback does not match this package')
      const installed = await match(target, all)
      if (
        !installed ||
        installed.version !== release.version ||
        (await json(join(target, marker))).id !== receipt.id
      )
        throw Error('App changed after install; rollback refused')
      const retained = join(history, 'retained-' + receipt.id)
      if (receipt.before) await match(retained, all)
      // Retain the new build too; never overwrite an unknown app or user configuration.
      const stage = join(apps, '.workflow-rollback-' + receipt.id)
      if (await exists(stage)) throw Error('Rollback stage already exists')
      if (receipt.before) {
        await cp(retained, stage, { recursive: true, errorOnExist: true, force: false })
        await copyConfiguration(target, stage)
      }
      const retired = join(apps, '.workflow-new-' + receipt.id)
      await rename(target, retired)
      try {
        if (receipt.before) await rename(stage, target)
      } catch (e) {
        await rename(retired, target)
        throw e
      }
      await cp(retired, join(history, 'rolled-back-' + receipt.id), {
        recursive: true,
        errorOnExist: true,
        force: false
      })
      await rm(retired, { recursive: true })
      return { state: 'rolled_back', version: receipt.before ?? null }
    }
    if (action !== 'install') throw Error('Unknown asset installer action')
    const before = await match(target, all)
    if (before?.version === release.version)
      return { state: 'unchanged', version: release.version, changed: false }
    const id = randomUUID(),
      stage = join(apps, '.workflow-stage-' + id),
      retired = join(apps, '.workflow-retired-' + id),
      retained = join(history, 'retained-' + id)
    if (before) {
      await cp(target, retained, { recursive: true, errorOnExist: true, force: false })
      await match(retained, all)
    }
    await cp(source, stage, { recursive: true, errorOnExist: true, force: false })
    // config.json is operator-owned and is never generated or printed by this installer.
    if (before) await copyConfiguration(target, stage)
    await match(stage, all)
    await writeFile(join(stage, marker), JSON.stringify({ id, version: release.version }) + '\n', {
      mode: 0o644,
      flag: 'wx'
    })
    const receipt = { id, version: release.version, before: before?.version ?? null },
      intent = join(history, 'intent-' + id + '.json')
    await save(intent, receipt)
    if (before) await rename(target, retired)
    try {
      await rename(stage, target)
    } catch (e) {
      if (before) await rename(retired, target)
      await rm(intent)
      throw e
    }
    await match(target, all)
    const receiptName = 'installed-' + id + '.json'
    await rename(intent, join(history, receiptName))
    const pointer = join(history, 'last-install.json'),
      temp = pointer + '.' + id
    await save(temp, { receipt: receiptName })
    await rename(temp, pointer)
    if (before) await rm(retired, { recursive: true })
    return { state: 'installed', version: release.version, changed: true, receipt: receiptName }
  } finally {
    await rm(lock, { recursive: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const release = await json('/distribution/release.json'),
      known = await json('/distribution/known-web-releases.json')
    console.log(
      JSON.stringify(
        await webAssets(
          {
            apps: '/web-apps',
            history: '/install-history',
            source: '/distribution/web',
            release,
            known
          },
          process.argv[2] ?? 'check'
        )
      )
    )
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}
