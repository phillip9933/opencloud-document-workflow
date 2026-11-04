// SPDX-License-Identifier: AGPL-3.0-only
import { XMLParser } from 'fast-xml-parser'
import { safePath } from '../src/domain/review.ts'
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: true,
  isArray: (n) => ['response', 'propstat', 'tag'].includes(n)
})
/** @param {unknown} value @returns {Record<string,unknown>} */
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid DAV properties')
  return /** @type {Record<string,unknown>} */ (value)
}
/** @param {unknown} value */
function optionalText(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Invalid DAV text property')
  return value
}
/** @param {unknown} value */
function isFolder(value) {
  return !!value && typeof value === 'object' && 'collection' in value
}
/** Shared XML envelope, scoped href and successful-property parsing.
 * @param {string} xml @param {string} base @param {'DAV'|'Trash'} kind
 */
function responses(xml, base, kind) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations are not allowed')
  const root = record(parser.parse(xml)).multistatus
  if (!root || typeof root !== 'object' || !('response' in root) || !Array.isArray(root.response))
    throw new Error(`Invalid ${kind} response`)
  const prefix = new URL(base),
    decodedBase = decodeURIComponent(prefix.pathname)
  return root.response.map((value) => {
    const response = record(value)
    if (typeof response.href !== 'string') throw new Error('Invalid DAV href')
    const href = new URL(response.href, base),
      decoded = decodeURIComponent(href.pathname)
    if (
      href.origin !== prefix.origin ||
      href.username ||
      href.password ||
      href.hash ||
      !decoded.startsWith(decodedBase)
    )
      throw new Error(
        kind === 'DAV'
          ? 'DAV response outside configured Space'
          : 'Trash response outside selected Space'
      )
    const path = decoded.slice(decodedBase.length).replace(/\/$/, '')
    const props = /** @type {Record<string,unknown>} */ ({})
    if (response.propstat !== undefined && !Array.isArray(response.propstat))
      throw new Error('Invalid DAV property status')
    for (const value of /** @type {unknown[]} */ (response.propstat ?? [])) {
      const status = record(value)
      if (typeof status.status === 'string' && /\s200\s/.test(status.status))
        Object.assign(props, record(status.prop))
    }
    return { path, props }
  })
}
/** @param {string} xml @param {string} base */
export function parseDAV(xml, base) {
  return responses(xml, base, 'DAV').map(({ path, props }) => {
    if (path) safePath(path)
    const tags =
      typeof props.tags === 'string'
        ? props.tags
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : props.tags && typeof props.tags === 'object' && 'tag' in props.tags
          ? props.tags.tag
          : []
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))
      throw new Error('Invalid DAV tags')
    return {
      ...(typeof props.displayname === 'string' ? { displayName: props.displayname } : {}),
      path,
      resourceId: optionalText(props.fileid ?? props.id),
      etag: optionalText(props.getetag),
      tags: [...new Set(/** @type {string[]} */ (tags))],
      folder: isFolder(props.resourcetype),
      size: Number(props.getcontentlength ?? 0)
    }
  })
}
/** @param {string} xml @param {string} base */
export function parseTrash(xml, base) {
  return responses(xml, base, 'Trash').flatMap(({ path: id, props }) => {
    if (!id) return []
    if (id.includes('/') || id === '.' || id === '..') throw new Error('Invalid Trash identity')
    const path = props['trashbin-original-location']
    if (typeof path !== 'string') throw new Error('Missing Trash original location')
    const clean = path.replace(/^\//, '')
    safePath(clean)
    return [
      {
        id,
        path: clean,
        resourceId: optionalText(props.fileid),
        size: Number(props.getcontentlength ?? 0),
        folder: isFolder(props.resourcetype)
      }
    ]
  })
}
