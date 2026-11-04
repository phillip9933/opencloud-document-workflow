// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { OCRPacks } from '../../companion/ocr-packs.mjs'
const data = Buffer.from('synthetic-tesseract-data'),
  blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),
  catalogInfo = {
    repository: 'tesseract-ocr/tessdata_fast',
    revision: 'a'.repeat(40),
    packs: [{ code: 'fra', blob, bytes: data.length }]
  }
function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-packs-')),
    calls = [],
    workflow = { lock: () => () => {} },
    manager = new OCRPacks(workflow, {
      directory: dir,
      catalogInfo,
      fetcher: async (url, opts) => {
        calls.push({ url, ...opts })
        return new Response(data)
      },
      validate: async (path) => assert.deepEqual(readFileSync(path), data),
      ...options
    })
  return {
    dir,
    calls,
    manager,
    async close() {
      await manager.stop()
      rmSync(dir, { recursive: true })
    }
  }
}
test('official pinned packs are verified, validated and atomically published without changing selected languages', async () => {
  const s = setup()
  try {
    await s.manager.start('fra')
    await s.manager.active
    assert.equal(s.manager.health.state, 'installed')
    assert.deepEqual(readFileSync(join(s.dir, 'fra.traineddata')), data)
    assert.equal(lstatSync(join(s.dir, 'fra.traineddata')).mode & 0o777, 0o644)
    assert.equal(s.calls[0].redirect, 'error')
    assert.equal(
      s.calls[0].url,
      `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${'a'.repeat(40)}/fra.traineddata`
    )
    assert.equal((await s.manager.status(false)).canManage, false)
  } finally {
    await s.close()
  }
})
test('unknown packs, traversal, corrupt downloads and invalid Tesseract data never install', async () => {
  for (const kind of ['unknown', 'traversal', 'corrupt', 'invalid']) {
    const s = setup(
      kind === 'corrupt'
        ? { fetcher: async () => new Response(Buffer.alloc(data.length)) }
        : kind === 'invalid'
          ? {
              validate: async () => {
                throw Error('invalid')
              }
            }
          : {}
    )
    try {
      if (kind === 'unknown' || kind === 'traversal')
        await assert.rejects(s.manager.start(kind === 'unknown' ? 'unknown' : '../fra'))
      else {
        await s.manager.start('fra')
        await s.manager.active
        assert.equal(s.manager.health.state, 'held')
      }
      assert.equal((await import('node:fs')).existsSync(join(s.dir, 'fra.traineddata')), false)
    } finally {
      await s.close()
    }
  }
})
test('existing packs and symlink targets are never replaced', async () => {
  for (const symlink of [false, true]) {
    const s = setup()
    try {
      const destination = join(s.dir, 'fra.traineddata')
      if (symlink) symlinkSync('/does/not/exist', destination)
      else writeFileSync(destination, 'retained')
      await s.manager.start('fra')
      await s.manager.active
      assert.equal(s.manager.health.state, 'held')
      assert.equal(s.calls.length, 0)
      if (!symlink) assert.equal(readFileSync(destination, 'utf8'), 'retained')
    } finally {
      await s.close()
    }
  }
})
test('concurrent installation serializes and rejects a second request while preserving the first', async () => {
  let finish
  const pending = new Promise((resolve) => {
      finish = resolve
    }),
    s = setup({
      fetcher: async () => {
        await pending
        return new Response(data)
      }
    })
  try {
    await s.manager.start('fra')
    await assert.rejects(s.manager.start('fra'), /Another/)
    finish()
    await s.manager.active
    assert.equal(s.manager.health.state, 'installed')
  } finally {
    await s.close()
  }
})
