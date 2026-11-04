// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError, errorCode } from './errors.ts'
import type { WorkflowErrorCode } from './errors.ts'
import {
  validateFilingRules,
  filingProfile,
  ruleSupported,
  renderFilingTemplate,
  explicitFolderMatches,
  taxYearFromPages
} from './filing.ts'
import { validateTagDiscovery, canonicalTag, discoveredTagAllowed } from './tag-discovery.ts'
import type { TagDiscovery } from './tag-discovery.ts'
import type { FilingRules } from './filing.ts'
import {
  printedDateISO,
  dateSearchCandidates,
  categorySupported,
  defaultLanguageProfile
} from './languages.ts'
import type { LanguageProfile } from './languages.ts'
export type Mode = 'off' | 'suggest' | 'automatic'
export type Policy = Record<'ocr' | 'rename' | 'move' | 'tags' | 'aiInput' | 'aiOutput', Mode> & {
  fields?: Mode
}
export const defaultPolicy = (): Policy => ({
  fields: 'suggest',
  ocr: 'off',
  rename: 'suggest',
  move: 'suggest',
  tags: 'suggest',
  aiInput: 'suggest',
  aiOutput: 'suggest'
})
export interface Evidence {
  page: number
  quote: string
}
export interface Claim {
  value: string
  evidence: Evidence[]
}
export interface Source {
  server: string
  account: string
  space: string
  resourceId: string
  path: string
  etag: string
  sha256: string
}
export interface Proposal {
  issuer: Claim
  date: Claim
  kind: Claim
  folder: Claim
  tags: Claim[]
}
export type ManualReviewReason = 'evidence' | 'date' | 'capacity' | 'text' | 'original' | 'rules'
export interface Bundle {
  tagDiscovery?: TagDiscovery
  manualReview?: { reason: ManualReviewReason }
  schemaVersion: 1
  source: Source
  pages: string[]
  proposal: Proposal | null
  rules?: FilingRules
  destinationSpace?: string
}
export interface Review {
  state: 'needs_review' | 'needs_ocr' | 'needs_details'
  bundle: Bundle
  proposal: Proposal | null
  excluded: Claim[]
  ruleMatch?: string
  ruleAmbiguous?: boolean
}

function fail(message: string, code: WorkflowErrorCode = 'VALIDATION_INVALID'): never {
  throw new WorkflowError(code, message)
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('Expected an object', 'INVALID_OBJECT')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(','))
    fail('Unexpected or missing fields', 'INVALID_FIELDS')
  return record
}
function text(value: unknown, max = 150): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail('Invalid text field', 'INVALID_TEXT')
  return value
}
export function validateSpace(value: unknown): string {
  const id = text(value, 400)
  if (/[/\\?#%\x00-\x20]/.test(id)) fail('Invalid Space')
  return id
}
export function safePath(value: unknown): string {
  const path = text(value, 400)
  if (
    path !== path.normalize('NFC') ||
    path
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.length > 150 || /[\\:?*<>|"#%]/.test(p))
  )
    fail('Unsafe document path')
  return path
}
// Return the actual cited span for unambiguous Unicode presentation/spacing differences.
// More than one possible source span remains ambiguous and is held.
function sourceQuote(page: string, quote: string, foldCase = false): string {
  if (page.includes(quote)) return quote
  const presentation = (value: string) => {
    const normalized = value.normalize('NFKC').replace(/\s/gu, '')
    return foldCase ? normalized.toLowerCase() : normalized
  }
  const compact = presentation(quote),
    source = presentation(page),
    at = source.indexOf(compact)
  if (!compact || at < 0 || source.indexOf(compact, at + 1) >= 0)
    fail('Quote is absent from its page', 'EVIDENCE_QUOTE')
  let count = 0,
    start = -1,
    end = -1
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(page)) {
    const normalized = presentation(part.segment)
    if (normalized) {
      if (count === at) start = part.index
      count += normalized.length
      if (count === at + compact.length) {
        end = part.index + part.segment.length
        break
      }
    }
  }
  if (start < 0 || end < 0 || end - start > 2000)
    fail('Quote is absent from its page', 'EVIDENCE_QUOTE')
  return page.slice(start, end)
}
const invalidFactControl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
function factValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 150 ||
    invalidFactControl.test(value)
  )
    fail('Invalid text field', 'INVALID_TEXT')
  return value
}
const filenameFact = (value: string) => value.replace(/[ \t]*[\r\n\t][ \t\r\n]*/g, ' ')
function claim(value: unknown, pages: string[], literal: boolean): Claim {
  const c = object(value, ['value', 'evidence'])
  let v = literal ? factValue(c.value) : text(c.value)
  if (!Array.isArray(c.evidence) || c.evidence.length < 1 || c.evidence.length > 8)
    fail('Missing bounded evidence', 'EVIDENCE_MISSING')
  const evidence = c.evidence.map((raw) => {
    const e = object(raw, ['page', 'quote'])
    if (!Number.isInteger(e.page)) fail('Invalid evidence page', 'EVIDENCE_PAGE')
    if (typeof e.quote !== 'string' || !e.quote.trim() || e.quote.length > 2000)
      fail('Quote is absent from its page', 'EVIDENCE_QUOTE')
    if ((e.page as number) < 1 || (e.page as number) > pages.length) {
      // Recover a misnumbered citation only from one verifiable source page.
      // Never choose between repeated quotes or invent source characters.
      const matches: Evidence[] = []
      pages.forEach((page, index) => {
        try {
          matches.push({ page: index + 1, quote: sourceQuote(page, e.quote as string, true) })
        } catch {
          /* This page does not contain that unique source span. */
        }
      })
      if (matches.length !== 1) fail('Invalid evidence page', 'EVIDENCE_PAGE')
      return matches[0]!
    }
    return {
      page: e.page as number,
      quote: sourceQuote(pages[(e.page as number) - 1]!, e.quote, true)
    }
  })
  // Restore the exact printed span rather than storing a model-normalized
  // name/date. Changed letters/digits and ambiguous presentation matches hold.
  if (literal && !evidence.some((e) => e.quote.includes(v))) {
    for (const e of evidence) {
      try {
        const match = sourceQuote(e.quote, v, true)
        if (match.length <= 150 && !invalidFactControl.test(match)) {
          v = match
          break
        }
      } catch (error) {
        if (errorCode(error) !== 'EVIDENCE_QUOTE') throw error
      }
    }
  }
  if (literal && (!evidence.some((e) => e.quote.includes(v)) || /[□■�]/.test(v)))
    fail('Fact is not present in its evidence', 'FACT_NOT_LITERAL')
  return { value: v, evidence }
}
function supported(c: Claim, profile: LanguageProfile) {
  return categorySupported(
    c.value,
    c.evidence.map((e) => e.quote),
    profile
  )
}
function printedDateSpan(checked: Claim, profile: LanguageProfile): Claim {
  try {
    printedDateISO(checked.value, profile)
    return checked
  } catch (original) {
    if (errorCode(original) !== 'DATE_UNSUPPORTED') throw original
    const matches = new Map<string, string>()
    for (const candidate of dateSearchCandidates(checked.value, profile)) {
      try {
        const printed = sourceQuote(checked.value, candidate, true)
        matches.set(printedDateISO(printed, profile), printed)
      } catch {
        /* Only an actual complete, unambiguous source span can replace a timestamp or annotation. */
      }
    }
    if (matches.size !== 1) throw original
    return { ...checked, value: [...matches.values()][0]! }
  }
}
function dateClaim(value: unknown, pages: string[], profile: LanguageProfile): Claim {
  try {
    return printedDateSpan(claim(value, pages, true), profile)
  } catch (error) {
    if (errorCode(error) !== 'FACT_NOT_LITERAL') throw error
    const checked = claim(value, pages, false),
      matches = new Set<string>()
    let expected: string
    try {
      expected = printedDateISO(checked.value, profile)
    } catch {
      throw error
    }
    for (const evidence of checked.evidence) {
      for (const candidate of dateSearchCandidates(evidence.quote, profile)) {
        try {
          const printed = sourceQuote(evidence.quote, candidate, true)
          if (
            printed.length <= 150 &&
            !/[\x00-\x1f\x7f]/.test(printed) &&
            printedDateISO(printed, profile) === expected
          )
            matches.add(printed)
        } catch {
          /* An incomplete, ambiguous or different printed date cannot support this value. */
        }
      }
    }
    if (matches.size !== 1) throw error
    return { ...checked, value: [...matches][0]! }
  }
}
export function filename(p: Proposal, profile = defaultLanguageProfile): string {
  if (p.issuer.value.includes('/') || p.kind.value.includes('/'))
    fail('A filename fact contains a path separator')
  const iso = printedDateISO(p.date.value, profile)
  return safePath(`${iso} ${filenameFact(p.issuer.value)} ${filenameFact(p.kind.value)}.pdf`)
}
export type DocumentInput = Omit<Bundle, 'proposal'>
export function validateDocumentInput(value: unknown, originalFile = false): DocumentInput {
  const b = object(value, [
    'schemaVersion',
    'source',
    'pages',
    ...(value && typeof value === 'object' && 'rules' in value ? ['rules'] : []),
    ...(value && typeof value === 'object' && 'destinationSpace' in value
      ? ['destinationSpace']
      : []),
    ...(value && typeof value === 'object' && 'tagDiscovery' in value ? ['tagDiscovery'] : [])
  ])
  if (b.schemaVersion !== 1) fail('Unsupported review schema')
  const s = object(b.source, ['server', 'account', 'space', 'resourceId', 'path', 'etag', 'sha256'])
  const server = text(s.server, 300)
  const url = new URL(server)
  if (
    url.origin !== server ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    fail('Expected a server origin without credentials')
  const source: Source = {
    server,
    account: text(s.account),
    space: text(s.space),
    resourceId: text(s.resourceId, 400),
    path: safePath(s.path),
    etag: text(s.etag, 300),
    sha256: text(s.sha256)
  }
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) fail('Expected SHA256')
  if (
    !Array.isArray(b.pages) ||
    (!originalFile && !b.pages.length) ||
    b.pages.length > 10000 ||
    b.pages.some((p) => typeof p !== 'string') ||
    b.pages.reduce((n, p) => n + p.length, 0) > 8000000
  )
    fail('Invalid or oversized extracted pages')
  const pages = [...b.pages] as string[],
    rules = b.rules ? validateFilingRules(b.rules as FilingRules) : undefined
  return {
    schemaVersion: 1,
    source,
    pages,
    ...(rules ? { rules } : {}),
    ...('destinationSpace' in b ? { destinationSpace: validateSpace(b.destinationSpace) } : {}),
    ...('tagDiscovery' in b ? { tagDiscovery: validateTagDiscovery(b.tagDiscovery) } : {})
  }
}
export function validateBundle(value: unknown, profile = defaultLanguageProfile): Review {
  const b = object(value, [
    'schemaVersion',
    'source',
    'pages',
    'proposal',
    ...(value && typeof value === 'object' && 'manualReview' in value ? ['manualReview'] : []),
    ...(value && typeof value === 'object' && 'rules' in value ? ['rules'] : []),
    ...(value && typeof value === 'object' && 'destinationSpace' in value
      ? ['destinationSpace']
      : []),
    ...(value && typeof value === 'object' && 'tagDiscovery' in value ? ['tagDiscovery'] : [])
  ])
  const originalFile =
    !!b.manualReview &&
    typeof b.manualReview === 'object' &&
    (b.manualReview as { reason?: unknown }).reason === 'original'
  const input = validateDocumentInput(
      {
        schemaVersion: b.schemaVersion,
        source: b.source,
        pages: b.pages,
        ...('rules' in b ? { rules: b.rules } : {}),
        ...('destinationSpace' in b ? { destinationSpace: b.destinationSpace } : {}),
        ...('tagDiscovery' in b ? { tagDiscovery: b.tagDiscovery } : {})
      },
      originalFile
    ),
    { source, pages, rules } = input
  if (rules) profile = filingProfile(rules)
  if ('manualReview' in b) {
    const manual = object(b.manualReview, ['reason'])
    if (
      !['evidence', 'date', 'capacity', 'text', 'original', 'rules'].includes(
        String(manual.reason)
      ) ||
      b.proposal !== null ||
      (!['text', 'original'].includes(String(manual.reason)) && pages.some((p) => !p.trim())) ||
      (manual.reason === 'original' && (pages.length !== 0 || /\.pdf$/i.test(source.path)))
    )
      fail('Invalid manual review')
    return {
      state: 'needs_details',
      bundle: {
        ...input,
        proposal: null,
        manualReview: { reason: manual.reason as ManualReviewReason }
      },
      proposal: null,
      excluded: []
    }
  }
  // Partial image-only documents also require OCR; no approval or model step.
  if (pages.some((p) => !p.trim())) {
    if (b.proposal !== null) fail('OCR-required input must not contain a proposal')
    return {
      state: 'needs_ocr',
      bundle: { ...input, proposal: null },
      proposal: null,
      excluded: []
    }
  }
  const p = object(b.proposal, ['issuer', 'date', 'kind', 'folder', 'tags'])
  if (
    !Array.isArray(p.tags) ||
    p.tags.length > (input.tagDiscovery ? 50 : (rules?.tags.length ?? 5))
  )
    fail('Invalid tag proposals', 'TAGS_INVALID')
  const proposal: Proposal = {
    issuer: claim(p.issuer, pages, true),
    date: dateClaim(p.date, pages, profile),
    kind: claim(p.kind, pages, true),
    folder: claim(p.folder, pages, false),
    tags: p.tags.map((t) => {
      const tag = claim(t, pages, false)
      return input.tagDiscovery
        ? { ...tag, value: canonicalTag(tag.value, input.tagDiscovery) }
        : tag
    })
  }
  if (
    rules
      ? !rules.folders.some((r) => r.value === proposal.folder.value)
      : proposal.folder.value !== 'Other' &&
        !['Utilities/Electricity', 'Utilities/Water', 'Finance', 'Correspondence'].includes(
          proposal.folder.value
        )
  )
    fail('Unknown folder category', 'FOLDER_UNKNOWN')
  if (
    proposal.folder.value !== 'Other' &&
    !(rules
      ? ruleSupported(
          proposal.folder.value,
          proposal.folder.evidence.map((e) => e.quote),
          rules.folders,
          rules
        )
      : supported(proposal.folder, profile))
  )
    fail('Folder lacks supporting evidence', 'FOLDER_UNSUPPORTED')
  const folderMatches = rules ? explicitFolderMatches(pages, rules) : []
  if (proposal.folder.value === 'Other' && folderMatches.length === 1)
    proposal.folder = folderMatches[0]!
  if (rules) printedDateISO(proposal.date.value, profile)
  else filename(proposal, profile)
  const tagSupported = (t: Claim) =>
    input.tagDiscovery
      ? discoveredTagAllowed(t.value, input.tagDiscovery)
      : rules
        ? ruleSupported(
            t.value,
            t.evidence.map((e) => e.quote),
            rules.tags,
            rules
          )
        : supported(t, profile)
  const excluded = proposal.tags.filter((t) => !tagSupported(t))
  const rawProposal = structuredClone(proposal)
  proposal.tags = proposal.tags.filter(tagSupported)
  return {
    state: 'needs_review',
    bundle: { ...input, proposal: rawProposal },
    proposal,
    excluded,
    ...(folderMatches.length === 1 ? { ruleMatch: folderMatches[0]!.value } : {}),
    ...(folderMatches.length > 1 ? { ruleAmbiguous: true } : {})
  }
}
// Deterministic source passages help a model choose a complete printed date;
// they are untrusted document data, and normal proposal validation still applies.
export function documentDateCandidates(value: DocumentInput): Claim[] {
  const input = validateDocumentInput(value),
    profile = input.rules ? filingProfile(input.rules) : defaultLanguageProfile,
    result: Claim[] = [],
    seen = new Set<string>()
  for (const [index, page] of input.pages.entries())
    for (const line of page.split(/\r?\n/)) {
      if (!line.trim() || line.length > 2000) continue
      for (const candidate of dateSearchCandidates(line, profile)) {
        try {
          const printed = sourceQuote(line, candidate, true)
          printedDateISO(printed, profile)
          const key = JSON.stringify([index, printed, line])
          if (seen.has(key)) continue
          seen.add(key)
          result.push({ value: printed, evidence: [{ page: index + 1, quote: line.trim() }] })
          if (result.length >= 24) return result
        } catch {
          /* Incomplete, ambiguous or changed source characters offer no date hint. */
        }
      }
    }
  return result
}
export type InspectedField = 'issuer' | 'date' | 'kind' | 'folder' | 'tags' | 'document'
export type InspectionCode =
  'shape' | 'quote' | 'literal' | 'date' | 'category' | 'value' | 'missing'
export interface ProposalInspection {
  verified: Partial<Proposal>
  issues: { field: InspectedField; code: InspectionCode }[]
}
// Read-only advice for manual review. Every retained claim passes the same
// evidence checks as an accepted proposal; this never creates filing actions.
export function inspectProposal(value: DocumentInput, raw: unknown): ProposalInspection {
  const input = validateDocumentInput(value),
    { pages, rules } = input,
    profile = rules ? filingProfile(rules) : defaultLanguageProfile
  const result: ProposalInspection = { verified: {}, issues: [] }
  let proposal: Record<string, unknown>
  try {
    proposal = object(raw, ['issuer', 'date', 'kind', 'folder', 'tags'])
  } catch {
    return { verified: {}, issues: [{ field: 'document', code: 'shape' }] }
  }
  const code = (error: unknown): InspectionCode => {
    const value = errorCode(error)
    if (value === 'FACT_NOT_LITERAL') return 'literal'
    if (value?.startsWith('DATE_')) return 'date'
    if (value === 'FOLDER_UNKNOWN' || value === 'FOLDER_UNSUPPORTED') return 'category'
    if (value?.startsWith('EVIDENCE_')) return 'quote'
    return 'value'
  }
  for (const field of ['issuer', 'date', 'kind', 'folder'] as const) {
    try {
      if (proposal[field] === null) {
        result.issues.push({ field, code: 'missing' })
        continue
      }
      const checked =
        field === 'date'
          ? dateClaim(proposal[field], pages, profile)
          : field === 'folder'
            ? claim(proposal[field], pages, false)
            : claim(proposal[field], pages, true)
      if (field === 'date') printedDateISO(checked.value, profile)
      if (field === 'folder') {
        if (
          rules
            ? !rules.folders.some((rule) => rule.value === checked.value)
            : ![
                'Other',
                'Utilities/Electricity',
                'Utilities/Water',
                'Finance',
                'Correspondence'
              ].includes(checked.value)
        )
          fail('Unknown folder category', 'FOLDER_UNKNOWN')
        if (
          checked.value !== 'Other' &&
          !(rules
            ? ruleSupported(
                checked.value,
                checked.evidence.map((e) => e.quote),
                rules.folders,
                rules
              )
            : supported(checked, profile))
        )
          fail('Folder lacks supporting evidence', 'FOLDER_UNSUPPORTED')
      }
      result.verified[field] = checked
    } catch (error) {
      result.issues.push({ field, code: code(error) })
    }
  }
  if (
    !Array.isArray(proposal.tags) ||
    proposal.tags.length > (input.tagDiscovery ? 50 : (rules?.tags.length ?? 5))
  )
    result.issues.push({ field: 'tags', code: 'shape' })
  else {
    result.verified.tags = []
    for (const rawTag of proposal.tags) {
      try {
        const checked = claim(rawTag, pages, false),
          tag = input.tagDiscovery
            ? { ...checked, value: canonicalTag(checked.value, input.tagDiscovery) }
            : checked
        if (
          input.tagDiscovery
            ? discoveredTagAllowed(tag.value, input.tagDiscovery)
            : rules
              ? ruleSupported(
                  tag.value,
                  tag.evidence.map((e) => e.quote),
                  rules.tags,
                  rules
                )
              : supported(tag, profile)
        )
          result.verified.tags.push(tag)
      } catch (error) {
        if (!result.issues.some((issue) => issue.field === 'tags'))
          result.issues.push({ field: 'tags', code: code(error) })
      }
    }
  }
  return result
}
export function parseBundle(json: string): Review {
  if (json.length > 32_000_000) fail('Review bundle exceeds 32 MB')
  return validateBundle(JSON.parse(json))
}
export function validatePolicy(value: unknown): Policy {
  const p = object(
    value,
    Object.keys(defaultPolicy()).filter(
      (key) => key !== 'fields' || (!!value && typeof value === 'object' && 'fields' in value)
    )
  )
  if (Object.values(p).some((v) => !['off', 'suggest', 'automatic'].includes(v as string)))
    fail('Invalid automation mode')
  return p as Policy
}
export interface ManualActions {
  target: string
  addTags: string[]
}
export function validateManualActions(value: unknown, originalPath?: string): ManualActions {
  const v = object(value, ['target', 'addTags'])
  const target = safePath(v.target)
  if (originalPath !== undefined) {
    const extension = (path: string) => {
      const name = path.split('/').pop()!,
        at = name.lastIndexOf('.')
      return at > 0 ? name.slice(at).toLowerCase() : ''
    }
    if (extension(originalPath) === '.pdf' || extension(target) !== extension(originalPath))
      fail('Keep the original file format when filing without conversion')
  } else if (!target.toLowerCase().endsWith('.pdf')) fail('A filing target must be a PDF path')
  if (!Array.isArray(v.addTags) || v.addTags.length > 50) fail('Invalid manual tags')
  const addTags = [...new Set(v.addTags.map((t) => text(t, 80)))].sort()
  if (addTags.some((t) => t !== t.normalize('NFC'))) fail('Tags must use normalized Unicode')
  return { target, addTags }
}
export function actions(review: Review, policy: Policy, manualActions?: ManualActions) {
  validatePolicy(policy)
  if (!review.proposal && !review.bundle.manualReview) return null
  if (review.bundle.manualReview && !manualActions) return null
  const destination =
    policy.move !== 'off' &&
    review.bundle.destinationSpace &&
    review.bundle.destinationSpace !== review.bundle.source.space
      ? { targetSpace: review.bundle.destinationSpace }
      : {}
  if (manualActions) {
    const manual = validateManualActions(
      manualActions,
      review.bundle.manualReview?.reason === 'original' ? review.bundle.source.path : undefined
    )
    if (policy.tags === 'off' && manual.addTags.length)
      fail('Enable tags before adding manual tags')
    const original = review.bundle.source.path.split('/'),
      target = manual.target.split('/')
    if (policy.rename === 'off' && original.at(-1) !== target.at(-1))
      fail('Enable filenames before changing the name')
    if (policy.move === 'off' && original.slice(0, -1).join('/') !== target.slice(0, -1).join('/'))
      fail('Enable folders before changing the folder')
    return { ...manual, ...destination }
  }
  if (!review.proposal) return null
  const old = review.bundle.source.path.split('/')
  const oldName = old.pop()!
  const rules = review.bundle.rules,
    iso = printedDateISO(review.proposal.date.value, filingProfile(rules)),
    values = {
      date: iso,
      year: iso.slice(0, 4),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      issuer: filenameFact(review.proposal.issuer.value),
      kind: filenameFact(review.proposal.kind.value),
      category: review.proposal.folder.value,
      original: oldName.replace(/\.pdf$/i, ''),
      resource: review.bundle.source.resourceId
    }
  const name =
    policy.rename === 'off'
      ? oldName
      : rules
        ? renderFilingTemplate(rules.nameTemplate, values)
        : filename(review.proposal)
  const categoryRule = rules?.folders.find((row) => row.value === review.proposal!.folder.value),
    folderTemplate = categoryRule?.folderTemplate ?? rules?.folderTemplate
  const folderValues =
    policy.move !== 'off' && folderTemplate?.includes('{taxYear}')
      ? { ...values, taxYear: taxYearFromPages(review.bundle.pages, categoryRule!.taxYearLabels!) }
      : values
  const folder =
    policy.move === 'off'
      ? old.join('/')
      : rules
        ? `${rules.root}/${renderFilingTemplate(folderTemplate!, folderValues)}`
        : `Filed/${review.proposal.folder.value}`
  return {
    ...destination,
    target: safePath(folder ? `${folder}/${name}` : name),
    addTags:
      policy.tags === 'off' ? [] : [...new Set(review.proposal.tags.map((t) => t.value))].sort()
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export async function reviewDigest(
  review: Review,
  policy: Policy,
  manualActions?: ManualActions
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonical({
      bundle: review.bundle,
      policy: validatePolicy(policy),
      actions: actions(review, policy, manualActions)
    })
  )
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}
export async function createApproval(
  review: Review,
  policy: Policy,
  manualActions?: ManualActions
) {
  // Re-validate at the boundary; never trust a caller's constructed Review object.
  const checked = validateBundle(review.bundle)
  if (checked.state !== 'needs_review' && checked.state !== 'needs_details')
    fail('OCR is required before review')
  if (checked.state === 'needs_details' && !manualActions)
    fail('Choose a destination before filing.')
  const planned = actions(checked, policy, manualActions)!
  if (
    !planned.targetSpace &&
    planned.target === checked.bundle.source.path &&
    !planned.addTags.length
  )
    fail('No proposed file changes are enabled')
  return {
    schemaVersion: 1,
    decision: 'approve',
    source: checked.bundle.source,
    ...(manualActions
      ? {
          manualActions: validateManualActions(
            manualActions,
            checked.bundle.manualReview?.reason === 'original'
              ? checked.bundle.source.path
              : undefined
          )
        }
      : {}),
    reviewDigest: await reviewDigest(checked, policy, manualActions),
    policy: { ...policy },
    actions: planned,
    reviewedAt: new Date().toISOString()
  }
}
export async function approvalMatches(
  approval: Omit<Awaited<ReturnType<typeof createApproval>>, 'reviewedAt'> & {
    reviewedAt?: string
  },
  bundle: Bundle,
  policy: Policy
) {
  const checked = validateBundle(bundle)
  return (
    approval.decision === 'approve' &&
    (checked.state === 'needs_review' ||
      (checked.state === 'needs_details' && !!approval.manualActions)) &&
    canonical(approval.source) === canonical(checked.bundle.source) &&
    canonical(approval.policy) === canonical(validatePolicy(policy)) &&
    canonical(approval.actions) === canonical(actions(checked, policy, approval.manualActions)) &&
    approval.reviewDigest === (await reviewDigest(checked, policy, approval.manualActions))
  )
}
