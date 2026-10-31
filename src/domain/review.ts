// SPDX-License-Identifier: AGPL-3.0-only
import {validateFilingRules,filingProfile,ruleSupported,renderFilingTemplate,explicitFolderMatches,taxYearFromPages} from './filing.ts'
import type {FilingRules} from './filing.ts'
import {printedDateISO,categorySupported,defaultLanguageProfile} from './languages.ts'
import type {LanguageProfile} from './languages.ts'
export type Mode = 'off' | 'suggest' | 'automatic'
export type Policy = Record<'ocr' | 'rename' | 'move' | 'tags' | 'aiInput' | 'aiOutput', Mode> & {fields?:Mode}
export const defaultPolicy = (): Policy => ({
  fields:'suggest', ocr: 'off', rename: 'suggest', move: 'suggest', tags: 'suggest', aiInput: 'suggest', aiOutput: 'suggest'
})
export interface Evidence { page: number; quote: string }
export interface Claim { value: string; evidence: Evidence[] }
export interface Source {
  server: string; account: string; space: string; resourceId: string
  path: string; etag: string; sha256: string
}
export interface Proposal { issuer: Claim; date: Claim; kind: Claim; folder: Claim; tags: Claim[] }
export interface Bundle { schemaVersion: 1; source: Source; pages: string[]; proposal: Proposal | null;rules?:FilingRules;destinationSpace?:string }
export interface Review { state: 'needs_review' | 'needs_ocr'; bundle: Bundle; proposal: Proposal | null; excluded: Claim[];ruleMatch?:string;ruleAmbiguous?:boolean }

function fail(message: string): never { throw new Error(message) }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) fail('Unexpected or missing fields')
  return record
}
function text(value: unknown, max = 150): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid text field')
  return value
}
export function validateSpace(value:unknown):string{const id=text(value,400);if(/[\/\\?#%\x00-\x20]/.test(id))fail('Invalid Space');return id}
export function safePath(value: unknown): string {
  const path = text(value, 400)
  if (path !== path.normalize('NFC') || path.split('/').some(p => !p || p === '.' || p === '..' || p.length > 150 || /[\\:?*<>|"#%]/.test(p))) fail('Unsafe document path')
  return path
}
function claim(value: unknown, pages: string[], literal: boolean): Claim {
  const c = object(value, ['value', 'evidence'])
  const v = text(c.value)
  if (!Array.isArray(c.evidence) || c.evidence.length < 1 || c.evidence.length > 8) fail('Missing bounded evidence')
  const evidence = c.evidence.map(raw => {
    const e = object(raw, ['page', 'quote'])
    if (!Number.isInteger(e.page) || (e.page as number) < 1 || (e.page as number) > pages.length) fail('Invalid evidence page')
    if (typeof e.quote !== 'string' || !e.quote.trim() || e.quote.length > 2000 || !pages[(e.page as number) - 1]!.includes(e.quote)) fail('Quote is absent from its page')
    return { page: e.page as number, quote: e.quote }
  })
  if (literal && (!evidence.some(e => e.quote.includes(v)) || /[□■�]/.test(v))) fail('Fact is not present in its evidence')
  return { value: v, evidence }
}
function supported(c:Claim,profile:LanguageProfile){return categorySupported(c.value,c.evidence.map(e=>e.quote),profile)}
export function filename(p: Proposal, profile=defaultLanguageProfile): string {
  if(p.issuer.value.includes('/') || p.kind.value.includes('/')) fail('A filename fact contains a path separator')
  const iso=printedDateISO(p.date.value,profile)
  return safePath(`${iso} ${p.issuer.value} ${p.kind.value}.pdf`)
}
export type DocumentInput = Omit<Bundle, 'proposal'>
export function validateDocumentInput(value: unknown): DocumentInput {
  const b = object(value, ['schemaVersion', 'source', 'pages',...(value&&typeof value==='object'&&'rules' in value?['rules']:[]),...(value&&typeof value==='object'&&'destinationSpace' in value?['destinationSpace']:[])])
  if (b.schemaVersion !== 1) fail('Unsupported review schema')
  const s = object(b.source, ['server', 'account', 'space', 'resourceId', 'path', 'etag', 'sha256'])
  const server = text(s.server, 300)
  const url = new URL(server)
  if (url.origin !== server || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('Expected a server origin without credentials')
  const source: Source = {
    server, account: text(s.account), space: text(s.space), resourceId: text(s.resourceId, 400),
    path: safePath(s.path), etag: text(s.etag, 300), sha256: text(s.sha256)
  }
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) fail('Expected SHA256')
  if (!Array.isArray(b.pages) || !b.pages.length || b.pages.length > 10000 || b.pages.some(p => typeof p !== 'string') || b.pages.reduce((n, p) => n + p.length, 0) > 8000000) fail('Invalid or oversized extracted pages')
  const pages = [...b.pages] as string[],rules=b.rules?validateFilingRules(b.rules as FilingRules):undefined
  return { schemaVersion: 1, source, pages,...(rules?{rules}:{}),...('destinationSpace' in b?{destinationSpace:validateSpace(b.destinationSpace)}:{}) }
}
export function validateBundle(value: unknown, profile=defaultLanguageProfile): Review {
  const b = object(value, ['schemaVersion', 'source', 'pages', 'proposal',...(value&&typeof value==='object'&&'rules' in value?['rules']:[]),...(value&&typeof value==='object'&&'destinationSpace' in value?['destinationSpace']:[])])
  const input=validateDocumentInput({schemaVersion:b.schemaVersion,source:b.source,pages:b.pages,...('rules' in b?{rules:b.rules}:{}),...('destinationSpace' in b?{destinationSpace:b.destinationSpace}:{})}),{source,pages,rules}=input
  if(rules)profile=filingProfile(rules)
  // Partial image-only documents also require OCR; no approval or model step.
  if (pages.some(p => !p.trim())) {
    if (b.proposal !== null) fail('OCR-required input must not contain a proposal')
    return { state: 'needs_ocr', bundle: {...input,proposal:null}, proposal: null, excluded: [] }
  }
  const p = object(b.proposal, ['issuer', 'date', 'kind', 'folder', 'tags'])
  if (!Array.isArray(p.tags) || p.tags.length > (rules?.tags.length??5)) fail('Invalid tag proposals')
  const proposal: Proposal = {
    issuer: claim(p.issuer, pages, true), date: claim(p.date, pages, true), kind: claim(p.kind, pages, true),
    folder: claim(p.folder, pages, false), tags: p.tags.map(t => claim(t, pages, false))
  }
  if (rules?!rules.folders.some(r=>r.value===proposal.folder.value):proposal.folder.value !== 'Other' && !['Utilities/Electricity', 'Utilities/Water', 'Finance', 'Correspondence'].includes(proposal.folder.value)) fail('Unknown folder category')
  if (proposal.folder.value !== 'Other' && !(rules?ruleSupported(proposal.folder.value,proposal.folder.evidence.map(e=>e.quote),rules.folders,rules):supported(proposal.folder,profile))) fail('Folder lacks supporting evidence')
  const folderMatches=rules?explicitFolderMatches(pages,rules):[]
  if(proposal.folder.value==='Other'&&folderMatches.length===1)proposal.folder=folderMatches[0]!
  if(rules)printedDateISO(proposal.date.value,profile);else filename(proposal,profile)
  const tagSupported=(t:Claim)=>rules?ruleSupported(t.value,t.evidence.map(e=>e.quote),rules.tags,rules):supported(t,profile)
  const excluded = proposal.tags.filter(t => !tagSupported(t))
  const rawProposal = structuredClone(proposal)
  proposal.tags = proposal.tags.filter(tagSupported)
  return { state: 'needs_review', bundle: {...input,proposal:rawProposal}, proposal,excluded,...(folderMatches.length===1?{ruleMatch:folderMatches[0]!.value}:{}),...(folderMatches.length>1?{ruleAmbiguous:true}:{}) }
}
export function parseBundle(json: string): Review {
  if (json.length > 32_000_000) fail('Review bundle exceeds 32 MB')
  return validateBundle(JSON.parse(json))
}
export function validatePolicy(value: unknown): Policy {
  const p = object(value, Object.keys(defaultPolicy()).filter(key=>key!=='fields'||!!value&&typeof value==='object'&&'fields' in value))
  if (Object.values(p).some(v => !['off', 'suggest', 'automatic'].includes(v as string))) fail('Invalid automation mode')
  return p as Policy
}
export interface ManualActions {target:string;addTags:string[]}
export function validateManualActions(value:unknown):ManualActions{
 const v=object(value,['target','addTags']);const target=safePath(v.target);if(!target.toLowerCase().endsWith('.pdf'))fail('A filing target must be a PDF path');if(!Array.isArray(v.addTags)||v.addTags.length>50)fail('Invalid manual tags');const addTags=[...new Set(v.addTags.map(t=>text(t,80)))].sort();if(addTags.some(t=>t!==t.normalize('NFC')))fail('Tags must use normalized Unicode');return{target,addTags}
}
export function actions(review: Review, policy: Policy, manualActions?:ManualActions) {
  validatePolicy(policy)
  if (!review.proposal) return null
  const destination=policy.move!=='off'&&review.bundle.destinationSpace&&review.bundle.destinationSpace!==review.bundle.source.space?{targetSpace:review.bundle.destinationSpace}:{}
  if(manualActions){const manual=validateManualActions(manualActions);if(policy.tags==='off'&&manual.addTags.length)fail('Enable tags before adding manual tags');const original=review.bundle.source.path.split('/'),target=manual.target.split('/');if(policy.rename==='off'&&original.at(-1)!==target.at(-1))fail('Enable filenames before changing the name');if(policy.move==='off'&&original.slice(0,-1).join('/')!==target.slice(0,-1).join('/'))fail('Enable folders before changing the folder');return {...manual,...destination}}
  const old = review.bundle.source.path.split('/')
  const oldName = old.pop()!
  const rules=review.bundle.rules,iso=printedDateISO(review.proposal.date.value,filingProfile(rules)),values={date:iso,year:iso.slice(0,4),month:iso.slice(5,7),day:iso.slice(8,10),issuer:review.proposal.issuer.value,kind:review.proposal.kind.value,category:review.proposal.folder.value,original:oldName.replace(/\.pdf$/i,''),resource:review.bundle.source.resourceId}
  const name = policy.rename === 'off' ? oldName : rules?renderFilingTemplate(rules.nameTemplate,values):filename(review.proposal)
  const categoryRule=rules?.folders.find(row=>row.value===review.proposal!.folder.value),folderTemplate=categoryRule?.folderTemplate??rules?.folderTemplate
  const folderValues=policy.move!=='off'&&folderTemplate?.includes('{taxYear}')?{...values,taxYear:taxYearFromPages(review.bundle.pages,categoryRule!.taxYearLabels!)}:values
  const folder = policy.move === 'off' ? old.join('/') : rules?`${rules.root}/${renderFilingTemplate(folderTemplate!,folderValues)}`:`Filed/${review.proposal.folder.value}`
  return { ...destination,target: safePath(folder ? `${folder}/${name}` : name), addTags: policy.tags === 'off' ? [] : [...new Set(review.proposal.tags.map(t => t.value))].sort() }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export async function reviewDigest(review: Review, policy: Policy, manualActions?:ManualActions): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ bundle: review.bundle, policy: validatePolicy(policy), actions: actions(review, policy, manualActions) }))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}
export async function createApproval(review: Review, policy: Policy, manualActions?:ManualActions) {
  // Re-validate at the boundary; never trust a caller's constructed Review object.
  const checked = validateBundle(review.bundle)
  if (checked.state !== 'needs_review') fail('OCR is required before review')
  const planned = actions(checked, policy, manualActions)!
  if (!planned.targetSpace&&planned.target === checked.bundle.source.path && !planned.addTags.length) fail('No proposed file changes are enabled')
  return {
    schemaVersion: 1, decision: 'approve', source: checked.bundle.source,
    ...(manualActions?{manualActions:validateManualActions(manualActions)}:{}),
    reviewDigest: await reviewDigest(checked, policy, manualActions), policy: { ...policy }, actions: planned,
    reviewedAt: new Date().toISOString()
  }
}
export async function approvalMatches(approval: Awaited<ReturnType<typeof createApproval>>, bundle: Bundle, policy: Policy) {
  const checked = validateBundle(bundle)
  return approval.decision === 'approve' && checked.state === 'needs_review'
    && canonical(approval.source) === canonical(checked.bundle.source)
    && canonical(approval.policy) === canonical(validatePolicy(policy))
    && canonical(approval.actions) === canonical(actions(checked, policy, approval.manualActions))
    && approval.reviewDigest === await reviewDigest(checked, policy, approval.manualActions)
}
