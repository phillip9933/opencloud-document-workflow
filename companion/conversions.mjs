// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { safePath } from '../src/domain/review.ts'
import { extensions } from './conversion-server.mjs'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const below = (path, root) => path === root || path.startsWith(root + '/')
export class Conversions {
  constructor(workflow, { render, endpoint = process.env.WORKFLOW_CONVERSION_URL } = {}) {
    this.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    this.w = workflow
    workflow.conversions = this
    this.db = workflow.db
    this.endpoint = endpoint
    this.render =
      render ??
      (async (bytes, extension) => {
        if (!endpoint) throw Error('The conversion service is not configured')
        const url = new URL(endpoint)
        if (
          url.protocol !== 'http:' ||
          url.hostname !== 'converter' ||
          url.port !== '5180' ||
          url.pathname !== '/' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw Error('Invalid private conversion service')
        const response = await fetch(endpoint + '/convert/' + extension, {
          method: 'POST',
          body: bytes,
          redirect: 'error',
          signal: AbortSignal.timeout(300000)
        })
        if (!response.ok) {
          const message = await response.text()
          const allowed = [
            'The file could not be exported to PDF; the original has been kept',
            'The converted PDF exceeds the 1000-page limit; the original has been kept',
            'Conversion took too long; the original has been kept',
            'The conversion tool could not read this file; the original has been kept'
          ]
          throw Error(
            allowed.includes(message) ? message : 'Conversion failed; the original has been kept'
          )
        }
        const parts = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 100 * 1024 * 1024) throw Error('Converted PDF exceeds limit')
          parts.push(chunk)
        }
        return Buffer.concat(parts)
      })
  }
  association(actor, resourceId) {
    const row = this.db
      .prepare(
        "select record from conversions where scope=? and json_extract(record,'$.pdfResourceId')=? and json_extract(record,'$.state')='done'"
      )
      .get(this.w.scope(actor), resourceId)
    if (!row) return null
    const record = JSON.parse(row.record)
    return {
      conversionId: record.id,
      archivePath: record.original,
      originalResourceId: record.resourceId,
      originalSha256: record.sha256,
      space: actor.space
    }
  }
  settings(actor) {
    return {
      archive:
        this.db
          .prepare('select archive from conversion_settings where scope=?')
          .get(this.w.scope(actor))?.archive ?? 'Archive',
      extensions,
      available: !!this.endpoint
    }
  }
  save(actor, archive) {
    safePath(archive)
    const inbox = this.w.intake.configuration(actor).folder
    if (below(archive, inbox) || below(inbox, archive))
      throw Error('Choose an archive outside the Inbox')
    this.db
      .prepare(
        'insert into conversion_settings values(?,?) on conflict(scope) do update set archive=excluded.archive'
      )
      .run(this.w.scope(actor), archive)
    return this.settings(actor)
  }
  record(actor, id) {
    const row = this.db
      .prepare('select record from conversions where id=? and scope=?')
      .get(id, this.w.scope(actor))
    if (!row) throw Error('Conversion not found')
    return JSON.parse(row.record)
  }
  persist(actor, record) {
    this.db
      .prepare(
        'insert into conversions values(?,?,?) on conflict(id) do update set record=excluded.record'
      )
      .run(record.id, this.w.scope(actor), JSON.stringify(record))
    if (
      record.state === 'done' &&
      this.db.prepare("select 1 from sqlite_master where type='table' and name='bulk_items'").get()
    )
      this.db
        .prepare(
          "update bulk_items set state='done',result=? where json_extract(result,'$.id')=? and operation in(select id from bulk_operations where scope=? and kind='convert')"
        )
        .run(JSON.stringify(record), record.id, this.w.scope(actor))
    return record
  }
  async folders(api, path) {
    const bits = path.split('/')
    for (let i = 1; i < bits.length; i++) await api.mkdir(bits.slice(0, i).join('/'))
  }
  async convert(actor, api, { path, resourceId, etag }) {
    safePath(path)
    if (this.w.scope(await api.identity()) !== this.w.scope(actor))
      throw Error('Conversion must use the Inbox Space')
    const inbox = this.w.intake.configuration(actor).folder,
      archive = this.settings(actor).archive,
      extension = path.split('.').pop().toLowerCase()
    if (
      !below(path, inbox) ||
      path === inbox ||
      below(archive, inbox) ||
      below(inbox, archive) ||
      !extensions.includes(extension)
    )
      throw Error('Choose a supported image or document inside the Inbox')
    if (!resourceId || !etag) throw Error('Inspect the original before creating a PDF')
    const id = hash(
        Buffer.from(JSON.stringify([this.w.scope(actor), resourceId, etag, path, archive]))
      ),
      release = this.w.lock(
        'conversion:' + hash(Buffer.from(JSON.stringify([this.w.scope(actor), resourceId])))
      )
    let resourceRelease
    try {
      this.w.documentTrash?.assertAvailable(actor, resourceId)
      resourceRelease = this.w.lock(
        `resource:${this.w.scope(actor)}:${this.w.transfers?.canonical(actor, resourceId) ?? resourceId}`
      )
      const old = this.db.prepare('select record from conversions where id=?').get(id)
      if (old) return await this.reconcile(actor, api, id)
      const source = await api.stat(path)
      if (!source || source.folder || source.resourceId !== resourceId || source.etag !== etag)
        throw Error('The original changed; refresh before converting')
      const max = this.w.configuration?.settings(actor)?.limits?.maxMiB ?? 100
      const bytes = await api.get(path, etag, max * 1024 * 1024),
        sha256 = hash(bytes),
        target = path + '.pdf',
        original = archive + '/' + path.slice(inbox.length + 1)
      if ((await api.stat(target)) || (await api.stat(original)))
        throw Error('A PDF or archived original already exists; no files were changed')
      const pdf = await this.render(bytes, extension)
      if (pdf.length > max * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
        throw Error('Conversion did not produce a bounded PDF')
      const fresh = await api.stat(path)
      if (fresh?.resourceId !== resourceId || fresh.etag !== etag)
        throw Error('The original changed during conversion')
      const record = {
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
      }
      this.persist(actor, record)
      // A persisted intent is never automatically replayed, even if PUT returns no response.
      try {
        const receipt = await api.put(target, pdf)
        if (!receipt?.resourceId) throw Error('Missing upload receipt')
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
  reformatRecord(actor, id) {
    const row = this.db
      .prepare('select record from conversion_reformats where id=? and scope=?')
      .get(id, this.w.scope(actor))
    if (!row) throw Error('PDF recreation not found')
    return JSON.parse(row.record)
  }
  saveReformat(actor, record) {
    this.db
      .prepare(
        'insert into conversion_reformats values(?,?,?) on conflict(id) do update set record=excluded.record'
      )
      .run(record.id, this.w.scope(actor), JSON.stringify(record))
    return record
  }
  async verifiedEventually(api, path, sha, resource, tags = []) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let file
      try {
        file = await this.verified(api, path, sha, resource)
      } catch (error) {
        if (![404, 412].includes(error.status)) throw error
      }
      if (file && tags.every((tag) => file.tags.includes(tag))) return file
      if (attempt < 4) await this.wait(500 * 2 ** attempt)
    }
    return null
  }
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
    if (
      this.db
        .prepare(
          "select 1 from decisions d join proposals p on p.id=d.job where p.scope=? and json_extract(p.input,'$.source.resourceId')=? and d.state<>'rejected' limit 1"
        )
        .get(this.w.scope(actor), record.pdfResourceId)
    )
      throw Error('Inspect the saved filing decision before recreating this PDF')
    if (
      this.db
        .prepare("select 1 from sqlite_master where type='table' and name='metadata_changes'")
        .get() &&
      this.db
        .prepare(
          "select 1 from metadata_changes where scope=? and resource=? and state='intent' limit 1"
        )
        .get(this.w.scope(actor), record.pdfResourceId)
    )
      throw Error('Verify the pending metadata save before recreating this PDF')
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
    if (!source) throw Error('The original workbook changed')
    const pdf = await this.render(
      await api.get(conversion.original, source.etag),
      conversion.original.split('.').pop().toLowerCase()
    )
    if (pdf.length > 100 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw Error('Conversion did not produce a bounded PDF')
    const fresh = await api.stat(conversion.original)
    if (fresh?.resourceId !== source.resourceId || fresh.etag !== source.etag)
      throw Error('The original workbook changed during rendering')
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
  async reformat(actor, api, id) {
    if (this.w.scope(await api.identity()) !== this.w.scope(actor))
      throw Error('PDF recreation must use the Inbox Space')
    const conversion = this.record(actor, id),
      extension = conversion.original.split('.').pop().toLowerCase()
    if (conversion.state !== 'done' || !['xlsx', 'xls', 'ods'].includes(extension))
      throw Error('Choose a converted spreadsheet')
    if (conversion.layoutVersion === 3)
      return { state: 'done', cached: true, path: conversion.target }
    const release = this.w.lock(
      'resource:' +
        this.w.scope(actor) +
        ':' +
        (this.w.transfers?.canonical(actor, conversion.pdfResourceId, actor.space) ??
          conversion.pdfResourceId)
    )
    try {
      this.w.documentTrash?.assertAvailable(actor, conversion.pdfResourceId)
      const intentId = hash(Buffer.from(JSON.stringify([id, conversion.pdfSha256, 3]))),
        prior = this.db.prepare('select id from conversion_reformats where id=?').get(intentId)
      if (prior) {
        const saved = this.reformatRecord(actor, intentId)
        return ['backup_intent', 'backup_tags_intent'].includes(saved.state) &&
          saved.backupResourceId
          ? await this.finishReformat(actor, api, saved)
          : await this.verifyReformat(actor, api, intentId)
      }
      if (!below(conversion.target, this.w.intake.configuration(actor).folder))
        throw Error('Only PDFs still in the Inbox can be recreated')
      if (
        this.db
          .prepare(
            "select 1 from decisions d join proposals p on p.id=d.job where p.scope=? and json_extract(p.input,'$.source.resourceId')=? and d.state<>'rejected' limit 1"
          )
          .get(this.w.scope(actor), conversion.pdfResourceId)
      )
        throw Error('Inspect the saved filing decision before recreating this PDF')
      if (
        this.db
          .prepare("select 1 from sqlite_master where type='table' and name='metadata_changes'")
          .get() &&
        this.db
          .prepare(
            "select 1 from metadata_changes where scope=? and resource=? and state='intent' limit 1"
          )
          .get(this.w.scope(actor), conversion.pdfResourceId)
      )
        throw Error('Verify the pending metadata save before recreating this PDF')
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
        throw Error('The workbook or PDF changed; refresh before recreating it')
      const bytes = await api.get(conversion.original, source.etag),
        pdf = await this.render(bytes, extension)
      if (pdf.length > 100 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
        throw Error('Conversion did not produce a bounded PDF')
      const sourceNow = await api.stat(conversion.original),
        pdfNow = await api.stat(conversion.target)
      if (
        sourceNow?.resourceId !== source.resourceId ||
        sourceNow.etag !== source.etag ||
        pdfNow?.resourceId !== current.resourceId ||
        pdfNow.etag !== current.etag
      )
        throw Error('The workbook or PDF changed during rendering')
      const archive = this.settings(actor).archive,
        backup =
          archive +
          '/PDF versions/' +
          conversion.target
            .slice(this.w.intake.configuration(actor).folder.length + 1)
            .replace(/\.pdf$/i, '-' + conversion.pdfSha256.slice(0, 12) + '.pdf')
      if (below(backup, this.w.intake.configuration(actor).folder) || (await api.stat(backup)))
        throw Error('Choose an unused archive location for the previous PDF')
      const record = {
        id: intentId,
        conversionId: id,
        path: conversion.target,
        backup,
        pdfResourceId: current.resourceId,
        etag: current.etag,
        tags: current.tags ?? [],
        layoutVersion: 3,
        oldSha256: conversion.pdfSha256,
        newSha256: hash(pdf),
        state: 'backup_intent'
      }
      await this.folders(api, backup)
      this.saveReformat(actor, record)
      try {
        const oldBytes = await api.get(conversion.target, current.etag)
        if (hash(oldBytes) !== record.oldSha256) throw Error('The PDF changed')
        const receipt = await api.put(backup, oldBytes)
        if (!receipt?.resourceId) throw Error('Missing backup receipt')
        record.backupResourceId = receipt.resourceId
        this.saveReformat(actor, record)
        if (
          !(await this.verifiedEventually(api, backup, record.oldSha256, record.backupResourceId))
        )
          throw Error('Previous PDF backup could not be verified')
        if (current.tags?.length) {
          record.state = 'backup_tags_intent'
          this.saveReformat(actor, record)
          await api.addTags(record.backupResourceId, current.tags)
          if (
            !(await this.verifiedEventually(
              api,
              backup,
              record.oldSha256,
              record.backupResourceId,
              current.tags
            ))
          )
            throw Error('Previous PDF tags could not be verified')
        }
        record.state = 'replace_intent'
        this.saveReformat(actor, record)
        await api.replacePDF(record.path, pdf, record.etag)
        const result = await this.verifyReformat(actor, api, intentId)
        if (result.state === 'done') this.w.event(actor, null, 'pdf_reformatted', { id: intentId })
        return result
      } catch {
        if (record.state === 'replace_intent') {
          try {
            return await this.verifyReformat(actor, api, intentId)
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
    } finally {
      release()
    }
  }
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
  async reconcile(actor, api, id) {
    const record = this.record(actor, id)
    if (record.state === 'done') return record
    return this.finish(actor, api, record, false)
  }
  async verified(api, path, sha256, resourceId) {
    const file = await api.stat(path)
    if (!file || file.folder || (resourceId && file.resourceId !== resourceId)) return null
    const digest = hash(await api.get(path, file.etag))
    return digest === sha256 ? file : null
  }
  async finish(actor, api, record, mayMove) {
    try {
      this.w.documentTrash?.assertAvailable(actor, record.resourceId)
      if (record.pdfResourceId) this.w.documentTrash?.assertAvailable(actor, record.pdfResourceId)
      if (!record.pdfResourceId)
        throw Error('The upload receipt is missing; the original has been kept for inspection')
      const pdf = await this.verified(api, record.target, record.pdfSha256, record.pdfResourceId)
      if (!pdf) throw Error('The PDF copy could not be verified; the original has been kept')
      record.pdfResourceId = pdf.resourceId
      this.persist(actor, record)
      const archived = await this.verified(api, record.original, record.sha256, record.resourceId),
        source = await api.stat(record.path)
      if (archived && !source) {
        record.state = 'done'
        this.persist(actor, record)
        return record
      }
      if (!mayMove) throw Error('Inspect this conversion before continuing; no write was repeated')
      if (
        !source ||
        source.resourceId !== record.resourceId ||
        source.etag !== record.etag ||
        hash(await api.get(record.path, source.etag)) !== record.sha256 ||
        (await api.stat(record.original))
      )
        throw Error('The original or archive destination changed')
      if (record.tags.length) {
        await api.addTags(pdf.resourceId, record.tags)
        const tagged = await api.stat(record.target)
        if (!record.tags.every((tag) => tagged?.tags.includes(tag)))
          throw Error('PDF tags could not be verified')
      }
      await this.folders(api, record.original)
      record.phase = 'archive'
      record.state = 'archive_intent'
      this.persist(actor, record)
      await api.move(record.path, record.original, record.etag)
      const moved = await this.verified(api, record.original, record.sha256, record.resourceId)
      if (!moved || (await api.stat(record.path)))
        throw Error('The archive move needs verification')
      record.state = 'done'
      this.persist(actor, record)
      this.w.event(actor, null, 'conversion_done', { id: record.id })
      return record
    } catch (e) {
      record.state = 'held'
      this.persist(actor, record)
      return { ...record, uncertain: true, error: e.message }
    }
  }
}
