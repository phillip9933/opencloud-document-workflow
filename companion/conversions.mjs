// SPDX-License-Identifier: AGPL-3.0-only
import { conversionAssociation } from './job-associations.mjs'
import { WorkflowError } from '../src/domain/errors.ts'
import { renderRemotePDF } from './conversion-client.mjs'
import { createHash } from 'node:crypto'
import { safePath } from '../src/domain/review.ts'
import { responseRecord } from './provider-response.mjs'
import { extensions } from './conversion-server.mjs'
/** @param {Buffer} bytes */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** @param {string} path @param {string} root */
const below = (path, root) => path === root || path.startsWith(root + '/')
export class Conversions {
  /** @param {import('./workflow.mjs').Workflow} workflow @param {{render?:(bytes:Buffer,extension:string)=>Promise<Buffer>,endpoint?:string}} options */
  constructor(workflow, { render, endpoint = process.env.WORKFLOW_CONVERSION_URL } = {}) {
    /** @param {number} ms */
    this.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    this.w = workflow
    this.db = workflow.db
    this.endpoint = endpoint
    this.render = render ?? ((bytes, extension) => renderRemotePDF(endpoint, bytes, extension))
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  inbox(actor) {
    return this.w.intake.configuration(actor)
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} resourceId */
  association(actor, resourceId) {
    const row = this.db
      .prepare(
        "select record from conversions where scope=? and json_extract(record,'$.pdfResourceId')=? and json_extract(record,'$.state')='done'"
      )
      .get(this.w.scope(actor), resourceId)
    if (!row) return null
    const record = JSON.parse(String(row.record))
    return conversionAssociation(record, actor.space)
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  settings(actor) {
    return {
      archive: String(
        this.db
          .prepare('select archive from conversion_settings where scope=?')
          .get(this.w.scope(actor))?.archive ?? 'Archive'
      ),
      extensions,
      available: !!this.endpoint
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} archive */
  save(actor, archive) {
    safePath(archive)
    const inbox = this.inbox(actor).folder
    if (below(archive, inbox) || below(inbox, archive))
      throw new WorkflowError('OPERATION_HELD', 'Choose an archive outside the Inbox')
    this.db
      .prepare(
        'insert into conversion_settings values(?,?) on conflict(scope) do update set archive=excluded.archive'
      )
      .run(this.w.scope(actor), archive)
    return this.settings(actor)
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id @returns {import('./orchestration-contracts.d.mts').ConversionRecord} */
  record(actor, id) {
    const row = this.db
      .prepare('select record from conversions where id=? and scope=?')
      .get(id, this.w.scope(actor))
    if (!row) throw new WorkflowError('OPERATION_HELD', 'Conversion not found')
    return JSON.parse(String(row.record))
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./orchestration-contracts.d.mts').ConversionRecord} record */
  persist(actor, record) {
    this.db
      .prepare(
        'insert into conversions values(?,?,?) on conflict(id) do update set record=excluded.record'
      )
      .run(record.id, this.w.scope(actor), JSON.stringify(record))
    if (record.state === 'done')
      this.db
        .prepare(
          "update bulk_items set state='done',result=? where json_extract(result,'$.id')=? and operation in(select id from bulk_operations where scope=? and kind='convert')"
        )
        .run(JSON.stringify(record), record.id, this.w.scope(actor))
    return record
  }
  /** @param {import('./contracts.d.mts').MutationAdapter} api @param {string} path */
  async folders(api, path) {
    const bits = path.split('/')
    for (let i = 1; i < bits.length; i++) await api.mkdir(bits.slice(0, i).join('/'))
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {{path:string,resourceId:string,etag:string}} input */
  async convert(actor, api, { path, resourceId, etag }) {
    safePath(path)
    if (this.w.scope(await api.identity()) !== this.w.scope(actor))
      throw new WorkflowError('OPERATION_HELD', 'Conversion must use the Inbox Space')
    const inbox = this.inbox(actor).folder,
      archive = this.settings(actor).archive,
      extension = path.split('.').pop()?.toLowerCase() ?? ''
    if (
      !below(path, inbox) ||
      path === inbox ||
      below(archive, inbox) ||
      below(inbox, archive) ||
      !extensions.includes(extension)
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'Choose a supported image or document inside the Inbox'
      )
    if (!resourceId || !etag)
      throw new WorkflowError('OPERATION_HELD', 'Inspect the original before creating a PDF')
    const id = hash(
        Buffer.from(JSON.stringify([this.w.scope(actor), resourceId, etag, path, archive]))
      ),
      release = this.w.lock(
        'conversion:' + hash(Buffer.from(JSON.stringify([this.w.scope(actor), resourceId])))
      )
    let resourceRelease
    try {
      this.w.documentTrash.assertAvailable(actor, resourceId)
      resourceRelease = this.w.lock(
        `resource:${this.w.scope(actor)}:${this.w.transfers.canonical(actor, resourceId)}`
      )
      const old = this.db.prepare('select record from conversions where id=?').get(id)
      if (old) return await this.reconcile(actor, api, id)
      const { record, pdf } = await this.prepareConversion(actor, api, {
        id,
        path,
        resourceId,
        etag,
        inbox,
        archive,
        extension
      })
      this.persist(actor, record)
      // A persisted intent is never automatically replayed, even if PUT returns no response.
      try {
        const receipt = await api.put(record.target, pdf)
        if (!receipt?.resourceId)
          throw new WorkflowError('OPERATION_HELD', 'Missing upload receipt')
        record.pdfResourceId = receipt.resourceId
        this.persist(actor, record)
      } catch {
        record.state = 'held'
        this.persist(actor, record)
        return {
          ...record,
          uncertain: true,
          error: 'Verify the PDF upload before moving the original'
        }
      }
      return await this.finish(actor, api, record, true)
    } finally {
      resourceRelease?.()
      release()
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id @returns {import('./orchestration-contracts.d.mts').ReformatRecord} */
  reformatRecord(actor, id) {
    const row = this.db
      .prepare('select record from conversion_reformats where id=? and scope=?')
      .get(id, this.w.scope(actor))
    if (!row) throw new WorkflowError('OPERATION_HELD', 'PDF recreation not found')
    return JSON.parse(String(row.record))
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./orchestration-contracts.d.mts').ReformatRecord} record */
  saveReformat(actor, record) {
    this.db
      .prepare(
        'insert into conversion_reformats values(?,?,?) on conflict(id) do update set record=excluded.record'
      )
      .run(record.id, this.w.scope(actor), JSON.stringify(record))
    return record
  }
  /** @param {import('./contracts.d.mts').MutationAdapter} api @param {string} path @param {string} sha @param {string|undefined} resource @param {string[]} tags */
  async verifiedEventually(api, path, sha, resource, tags = []) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let file
      try {
        file = await this.verified(api, path, sha, resource)
      } catch (error) {
        if (![404, 412].includes(Number(responseRecord(error)?.status))) throw error
      }
      if (file && tags.every((tag) => file.tags.includes(tag))) return file
      if (attempt < 4) await this.wait(500 * 2 ** attempt)
    }
    return null
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id */
  async verifyReformat(actor, api, id) {
    const record = this.reformatRecord(actor, id),
      backup = await this.verifiedEventually(
        api,
        record.backup,
        record.oldSha256,
        record.backupResourceId
      )
    if (!backup || !record.backupResourceId)
      return {
        ...record,
        uncertain: true,
        error: 'The previous PDF backup needs inspection; no write was repeated'
      }
    const current = await this.verifiedEventually(
      api,
      record.path,
      record.newSha256,
      record.pdfResourceId
    )
    if (!current || !record.tags.every((tag) => current.tags.includes(tag)))
      return {
        ...record,
        uncertain: true,
        error: 'Inspect the current PDF before continuing; no replacement was repeated'
      }
    const conversion = this.record(actor, record.conversionId)
    conversion.pdfSha256 = record.newSha256
    conversion.layoutVersion = record.layoutVersion ?? 2
    this.persist(actor, conversion)
    record.state = 'done'
    this.saveReformat(actor, record)
    return record
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./orchestration-contracts.d.mts').ConversionAdapter} api @param {import('./orchestration-contracts.d.mts').ReformatRecord} record */
  async finishReformat(actor, api, record) {
    // An explicit recreation request may continue only before a replacement intent
    // exists. A recorded replacement intent is reconciled read-only, never resent.
    if (!['backup_intent', 'backup_tags_intent'].includes(record.state) || !record.backupResourceId)
      return this.verifyReformat(actor, api, record.id)
    const conversion = this.record(actor, record.conversionId),
      backup = await this.verifiedEventually(
        api,
        record.backup,
        record.oldSha256,
        record.backupResourceId
      ),
      current = await this.verified(api, record.path, record.oldSha256, record.pdfResourceId)
    if (!backup || !current || current.etag !== record.etag)
      return {
        ...record,
        uncertain: true,
        error: 'Inspect the verified backup and current PDF before continuing'
      }
    this.assertReformatAvailable(actor, record.pdfResourceId)
    if (!record.tags.every((tag) => backup.tags.includes(tag))) {
      if (record.state === 'backup_intent') {
        record.state = 'backup_tags_intent'
        this.saveReformat(actor, record)
        try {
          await api.addTags(record.backupResourceId, record.tags)
        } catch {
          /* Only read-back verification follows an unconfirmed tag write. */
        }
      }
      const tagged = await this.verifiedEventually(
        api,
        record.backup,
        record.oldSha256,
        record.backupResourceId,
        record.tags
      )
      if (!tagged)
        return {
          ...record,
          uncertain: true,
          error: 'The previous PDF tags need verification; no tag write was repeated'
        }
    }
    const source = await this.verified(
      api,
      conversion.original,
      conversion.sha256,
      conversion.resourceId
    )
    if (!source) throw new WorkflowError('OPERATION_HELD', 'The original workbook changed')
    const pdf = await this.render(
      await api.get(conversion.original, source.etag),
      conversion.original.split('.').pop()?.toLowerCase() ?? ''
    )
    if (pdf.length > 100 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new WorkflowError('OPERATION_HELD', 'Conversion did not produce a bounded PDF')
    const fresh = await api.stat(conversion.original)
    if (fresh?.resourceId !== source.resourceId || fresh.etag !== source.etag)
      throw new WorkflowError('OPERATION_HELD', 'The original workbook changed during rendering')
    record.newSha256 = hash(pdf)
    record.layoutVersion = 3
    record.state = 'replace_intent'
    this.saveReformat(actor, record)
    try {
      await api.replacePDF(record.path, pdf, record.etag)
    } catch {
      /* Only read-back verification follows an unconfirmed replacement. */
    }
    return this.verifyReformat(actor, api, record.id)
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} resource */
  assertReformatAvailable(actor, resource) {
    if (
      this.db
        .prepare(
          "select 1 from decisions d join proposals p on p.id=d.job where p.scope=? and json_extract(p.input,'$.source.resourceId')=? and d.state<>'rejected' limit 1"
        )
        .get(this.w.scope(actor), resource)
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'Inspect the saved filing decision before recreating this PDF'
      )
    if (
      this.db
        .prepare(
          "select 1 from metadata_changes where scope=? and resource=? and state='intent' limit 1"
        )
        .get(this.w.scope(actor), resource)
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'Verify the pending metadata save before recreating this PDF'
      )
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./orchestration-contracts.d.mts').ConversionAdapter} api @param {string} id */
  async reformat(actor, api, id) {
    if (this.w.scope(await api.identity()) !== this.w.scope(actor))
      throw new WorkflowError('OPERATION_HELD', 'PDF recreation must use the Inbox Space')
    const conversion = this.record(actor, id),
      extension = conversion.original.split('.').pop()?.toLowerCase() ?? ''
    if (
      conversion.state !== 'done' ||
      !conversion.pdfResourceId ||
      !['xlsx', 'xls', 'ods'].includes(extension)
    )
      throw new WorkflowError('OPERATION_HELD', 'Choose a converted spreadsheet')
    if (conversion.layoutVersion === 3)
      return { state: 'done', cached: true, path: conversion.target }
    const release = this.w.lock(
      'resource:' +
        this.w.scope(actor) +
        ':' +
        this.w.transfers.canonical(actor, conversion.pdfResourceId, actor.space)
    )
    try {
      this.w.documentTrash.assertAvailable(actor, conversion.pdfResourceId)
      const intentId = hash(Buffer.from(JSON.stringify([id, conversion.pdfSha256, 3]))),
        prior = this.db.prepare('select id from conversion_reformats where id=?').get(intentId)
      if (prior) {
        const saved = this.reformatRecord(actor, intentId)
        return ['backup_intent', 'backup_tags_intent'].includes(saved.state) &&
          saved.backupResourceId
          ? await this.finishReformat(actor, api, saved)
          : await this.verifyReformat(actor, api, intentId)
      }
      const { record, current, pdf } = await this.prepareReformat(
        actor,
        api,
        { ...conversion, pdfResourceId: conversion.pdfResourceId },
        extension,
        intentId
      )
      return await this.replaceReformat(actor, api, record, current, pdf)
    } finally {
      release()
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {{id:string,path:string,resourceId:string,etag:string,inbox:string,archive:string,extension:string}} input */
  async prepareConversion(actor, api, { id, path, resourceId, etag, inbox, archive, extension }) {
    const source = await api.stat(path)
    if (!source || source.folder || source.resourceId !== resourceId || source.etag !== etag)
      throw new WorkflowError('SOURCE_CHANGED', 'The original changed; refresh before converting')
    const max = this.w.configuration.settings(actor).limits.maxMiB ?? 100
    const bytes = await api.get(path, etag, max * 1024 * 1024),
      sha256 = hash(bytes),
      target = path + '.pdf',
      original = archive + '/' + path.slice(inbox.length + 1)
    if ((await api.stat(target)) || (await api.stat(original)))
      throw new WorkflowError(
        'OPERATION_HELD',
        'A PDF or archived original already exists; no files were changed'
      )
    const pdf = await this.render(bytes, extension)
    if (pdf.length > max * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new WorkflowError('OPERATION_HELD', 'Conversion did not produce a bounded PDF')
    const fresh = await api.stat(path)
    if (fresh?.resourceId !== resourceId || fresh.etag !== etag)
      throw new WorkflowError('SOURCE_CHANGED', 'The original changed during conversion')
    const record = /** @type {import('./orchestration-contracts.d.mts').ConversionRecord} */ ({
      id,
      path,
      target,
      original,
      resourceId,
      etag,
      sha256,
      pdfSha256: hash(pdf),
      tags: source.tags ?? [],
      phase: 'upload',
      state: 'upload_intent'
    })

    return { record, pdf }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./orchestration-contracts.d.mts').ConversionAdapter} api @param {import('./orchestration-contracts.d.mts').ConversionRecord & {pdfResourceId:string}} conversion @param {string} extension @param {string} intentId */
  async prepareReformat(actor, api, conversion, extension, intentId) {
    if (!below(conversion.target, this.inbox(actor).folder))
      throw new WorkflowError('OPERATION_HELD', 'Only PDFs still in the Inbox can be recreated')
    this.assertReformatAvailable(actor, conversion.pdfResourceId)
    const source = await this.verified(
        api,
        conversion.original,
        conversion.sha256,
        conversion.resourceId
      ),
      current = await this.verified(
        api,
        conversion.target,
        conversion.pdfSha256,
        conversion.pdfResourceId
      )
    if (!source || !current)
      throw new WorkflowError(
        'OPERATION_HELD',
        'The workbook or PDF changed; refresh before recreating it'
      )
    const bytes = await api.get(conversion.original, source.etag),
      pdf = await this.render(bytes, extension)
    if (pdf.length > 100 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new WorkflowError('OPERATION_HELD', 'Conversion did not produce a bounded PDF')
    const sourceNow = await api.stat(conversion.original),
      pdfNow = await api.stat(conversion.target)
    if (
      sourceNow?.resourceId !== source.resourceId ||
      sourceNow.etag !== source.etag ||
      pdfNow?.resourceId !== current.resourceId ||
      pdfNow.etag !== current.etag
    )
      throw new WorkflowError('OPERATION_HELD', 'The workbook or PDF changed during rendering')
    const archive = this.settings(actor).archive,
      backup =
        archive +
        '/PDF versions/' +
        conversion.target
          .slice(this.inbox(actor).folder.length + 1)
          .replace(/\.pdf$/i, '-' + conversion.pdfSha256.slice(0, 12) + '.pdf')
    if (below(backup, this.inbox(actor).folder) || (await api.stat(backup)))
      throw new WorkflowError(
        'OPERATION_HELD',
        'Choose an unused archive location for the previous PDF'
      )
    const record = /** @type {import('./orchestration-contracts.d.mts').ReformatRecord} */ ({
      id: intentId,
      conversionId: conversion.id,
      path: conversion.target,
      backup,
      pdfResourceId: current.resourceId,
      etag: current.etag,
      tags: current.tags ?? [],
      layoutVersion: 3,
      oldSha256: conversion.pdfSha256,
      newSha256: hash(pdf),
      state: 'backup_intent'
    })

    return { record, current, pdf }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./orchestration-contracts.d.mts').ConversionAdapter} api @param {import('./orchestration-contracts.d.mts').ReformatRecord} record @param {import('./contracts.d.mts').FileEntry} current @param {Buffer} pdf */
  async replaceReformat(actor, api, record, current, pdf) {
    await this.folders(api, record.backup)
    this.saveReformat(actor, record)
    try {
      const oldBytes = await api.get(record.path, current.etag)
      if (hash(oldBytes) !== record.oldSha256)
        throw new WorkflowError('OPERATION_HELD', 'The PDF changed')
      const receipt = await api.put(record.backup, oldBytes)
      if (!receipt?.resourceId) throw new WorkflowError('OPERATION_HELD', 'Missing backup receipt')
      record.backupResourceId = receipt.resourceId
      this.saveReformat(actor, record)
      if (
        !(await this.verifiedEventually(
          api,
          record.backup,
          record.oldSha256,
          record.backupResourceId
        ))
      )
        throw new WorkflowError('OPERATION_HELD', 'Previous PDF backup could not be verified')
      if (current.tags?.length) {
        record.state = 'backup_tags_intent'
        this.saveReformat(actor, record)
        await api.addTags(record.backupResourceId, current.tags)
        if (
          !(await this.verifiedEventually(
            api,
            record.backup,
            record.oldSha256,
            record.backupResourceId,
            current.tags
          ))
        )
          throw new WorkflowError('OPERATION_HELD', 'Previous PDF tags could not be verified')
      }
      record.state = 'replace_intent'
      this.saveReformat(actor, record)
      await api.replacePDF(record.path, pdf, record.etag)
      const result = await this.verifyReformat(actor, api, record.id)
      if (result.state === 'done') this.w.event(actor, null, 'pdf_reformatted', { id: record.id })
      return result
    } catch {
      if (record.state === 'replace_intent') {
        try {
          return await this.verifyReformat(actor, api, record.id)
        } catch {
          /* Keep the unresolved replacement intent; never repeat the write here. */
        }
      }
      return {
        ...record,
        uncertain: true,
        error:
          'PDF recreation needs verification. The workbook is unchanged; no replacement will be repeated automatically'
      }
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id */
  async continueArchive(actor, api, id) {
    const record = this.record(actor, id),
      release = this.w.lock(
        'conversion:' + hash(Buffer.from(JSON.stringify([this.w.scope(actor), record.resourceId])))
      )
    try {
      return await this.finish(actor, api, record, record.phase !== 'archive')
    } finally {
      release()
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id */
  async reconcile(actor, api, id) {
    const record = this.record(actor, id)
    if (record.state === 'done') return record
    return this.finish(actor, api, record, false)
  }
  /** @param {import('./contracts.d.mts').MutationAdapter} api @param {string} path @param {string} sha256 @param {string|undefined} resourceId */
  async verified(api, path, sha256, resourceId) {
    const file = await api.stat(path)
    if (!file || file.folder || (resourceId && file.resourceId !== resourceId)) return null
    const digest = hash(await api.get(path, file.etag))
    return digest === sha256 ? file : null
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {import('./orchestration-contracts.d.mts').ConversionRecord} record @param {boolean} mayMove */
  async finish(actor, api, record, mayMove) {
    try {
      this.w.documentTrash.assertAvailable(actor, record.resourceId)
      if (record.pdfResourceId) this.w.documentTrash.assertAvailable(actor, record.pdfResourceId)
      if (!record.pdfResourceId)
        throw new WorkflowError(
          'OPERATION_HELD',
          'The upload receipt is missing; the original has been kept for inspection'
        )
      const pdf = await this.verified(api, record.target, record.pdfSha256, record.pdfResourceId)
      if (!pdf)
        throw new WorkflowError(
          'OPERATION_HELD',
          'The PDF copy could not be verified; the original has been kept'
        )
      record.pdfResourceId = pdf.resourceId
      this.persist(actor, record)
      const archived = await this.verified(api, record.original, record.sha256, record.resourceId),
        source = await api.stat(record.path)
      if (archived && !source) {
        record.state = 'done'
        this.persist(actor, record)
        return record
      }
      if (!mayMove)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Inspect this conversion before continuing; no write was repeated'
        )
      if (
        !source ||
        source.resourceId !== record.resourceId ||
        source.etag !== record.etag ||
        hash(await api.get(record.path, source.etag)) !== record.sha256 ||
        (await api.stat(record.original))
      )
        throw new WorkflowError('OPERATION_HELD', 'The original or archive destination changed')
      if (record.tags.length) {
        await api.addTags(pdf.resourceId, record.tags)
        const tagged = await api.stat(record.target)
        if (!record.tags.every((tag) => tagged?.tags.includes(tag)))
          throw new WorkflowError('OPERATION_HELD', 'PDF tags could not be verified')
      }
      await this.folders(api, record.original)
      record.phase = 'archive'
      record.state = 'archive_intent'
      this.persist(actor, record)
      await api.move(record.path, record.original, record.etag)
      const moved = await this.verified(api, record.original, record.sha256, record.resourceId)
      if (!moved || (await api.stat(record.path)))
        throw new WorkflowError('OPERATION_HELD', 'The archive move needs verification')
      record.state = 'done'
      this.persist(actor, record)
      this.w.event(actor, null, 'conversion_done', { id: record.id })
      return record
    } catch (e) {
      record.state = 'held'
      this.persist(actor, record)
      return {
        ...record,
        uncertain: true,
        error: e instanceof Error ? e.message : 'Conversion needs verification'
      }
    }
  }
}
