// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { responseRecord } from './provider-response.mjs'
import { readFile, lstat, realpath, mkdir, open, link, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
/** @typedef {{code:string,bytes:number,blob:string,downloadPath?:string}} Pack */
/** @typedef {{revision:string,repository:string,packs:Pack[]}} Catalog */
/** @typedef {{directory?:string,fetcher?:typeof fetch,validate?:(path:string)=>Promise<unknown>,installed?:()=>Promise<string[]>,catalogInfo?:Catalog}} PackOptions */
/** @type {Catalog} */
const catalog = JSON.parse(await readFile(new URL('./ocr-catalog.json', import.meta.url), 'utf8'))
export class OCRPacks {
  /** @param {import('./workflow.mjs').Workflow} workflow @param {PackOptions} options */
  constructor(
    workflow,
    {
      directory,
      fetcher = fetch,
      validate = async () => {},
      installed = async () => [],
      catalogInfo = catalog
    } = {}
  ) {
    this.w = workflow
    this.directory = directory ? resolve(directory) : null
    this.fetcher = fetcher
    this.validate = validate
    this.installed = installed
    this.catalog = catalogInfo
    /** @type {Promise<void>|null} */
    this.active = null
    /** @type {{state:string,code?:string,message?:string}} */
    this.health = { state: 'idle' }
    this.stopped = false
  }
  /** @param {boolean} canManage */
  async status(canManage) {
    const installed = await this.installed()
    return {
      canManage: !!canManage,
      enabled: !!this.directory,
      revision: this.catalog.revision,
      packs: this.catalog.packs.map((p) => ({
        code: p.code,
        bytes: p.bytes,
        installed: installed.includes(p.code)
      })),
      installation: this.health
    }
  }
  /** @param {string} code */
  async start(code) {
    if (this.stopped || !this.directory)
      throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'OCR pack installation is not configured')
    const pack = this.catalog.packs.find((p) => p.code === code)
    if (!pack) throw new WorkflowError('VALIDATION_INVALID', 'Choose an official OCR language pack')
    if (this.active)
      throw new WorkflowError('OPERATION_HELD', 'Another OCR language is being installed')
    const release = this.w.lock('__ocr_install__')
    this.health = { state: 'installing', code }
    this.active = this.install(pack)
      .then(() => {
        this.health = { state: 'installed', code }
      })
      .catch(() => {
        this.health = {
          state: 'held',
          code,
          message: 'Language installation failed. Existing languages are unchanged.'
        }
      })
      .finally(() => {
        release()
        this.active = null
      })
    return this.health
  }
  /** @param {Pack} pack */
  async install(pack) {
    if (!this.directory)
      throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'OCR pack installation is not configured')
    const root = await realpath(this.directory),
      info = await lstat(this.directory)
    if (
      root !== this.directory ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o022
    )
      throw new WorkflowError('OPERATION_HELD', 'A protected OCR data directory is required')
    const destination = join(root, pack.code + '.traineddata'),
      parent = dirname(destination)
    if (parent !== root) {
      try {
        await mkdir(parent, { mode: 0o755 })
      } catch (e) {
        if (responseRecord(e)?.code !== 'EEXIST') throw e
      }
      if ((await realpath(parent)) !== parent || (await lstat(parent)).isSymbolicLink())
        throw new WorkflowError('OPERATION_HELD', 'Unsafe OCR directory')
    }
    try {
      await lstat(destination)
      throw new WorkflowError('OPERATION_HELD', 'OCR language already exists')
    } catch (e) {
      if (responseRecord(e)?.code !== 'ENOENT') throw e
    }
    const url = `https://raw.githubusercontent.com/${this.catalog.repository}/${this.catalog.revision}/${pack.downloadPath ?? pack.code + '.traineddata'}`,
      response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120000) })
    if (!response.ok) {
      await response.body?.cancel()
      throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Official OCR download unavailable')
    }
    const chunks = []
    let length = 0
    for await (const chunk of response.body ?? []) {
      length += chunk.length
      if (length > pack.bytes || length > 128 * 1024 * 1024)
        throw new WorkflowError('VALIDATION_INVALID', 'OCR language exceeds expected size')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    if (
      bytes.length !== pack.bytes ||
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== pack.blob
    )
      throw new WorkflowError('OPERATION_HELD', 'OCR pack integrity mismatch')
    const temp = join(parent, '.ocr-' + randomUUID()),
      file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
      await file.close()
      await this.validate(temp)
      await lstat(destination).then(
        () => {
          throw new WorkflowError('OPERATION_HELD', 'OCR language already exists')
        },
        (e) => {
          if (responseRecord(e)?.code !== 'ENOENT') throw e
        }
      )
      await link(temp, destination)
      const handle = await open(destination, 'r')
      try {
        await handle.chmod(0o644)
      } finally {
        await handle.close()
      }
      const dir = await open(parent, 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    } finally {
      await file.close().catch(() => {})
      await unlink(temp).catch((e) => {
        if (responseRecord(e)?.code !== 'ENOENT') throw e
      })
    }
  }
  async stop() {
    this.stopped = true
    await this.active
  }
}
