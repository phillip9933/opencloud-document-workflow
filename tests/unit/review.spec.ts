import { actions, reviewDigest, approvalMatches, createApproval, defaultPolicy, filename, parseBundle, safePath, validateBundle, validatePolicy } from '../../src/domain/review'
import { samples } from '../../src/domain/samples'

const example = () => samples()[0]!
describe('Untrusted document evidence', () => {
  it('derives filenames from literal English and Japanese facts', () => {
    expect(filename(validateBundle(example()).proposal!)).toBe('2026-10-29 Example Electricity Company Electricity invoice.pdf')
    expect(filename(validateBundle(samples()[1]!).proposal!)).toBe('2026-10-29 飯山市上下水道事業 水道料金請求書.pdf')
  })
  it('holds image-only and partial image-only input for OCR', () => {
    expect(validateBundle(samples()[2]!).state).toBe('needs_ocr')
    const b = example(); b.pages.push(''); b.proposal = null
    expect(validateBundle(b).state).toBe('needs_ocr')
  })
  it('rejects fabricated proposals for OCR-required input', () => {
    const b = example(); b.pages = ['']
    expect(() => validateBundle(b)).toThrow('OCR-required')
  })
  it('rejects wrong Japanese municipality even with a real unrelated quote', () => {
    const b = samples()[1]!; b.proposal!.issuer.value = '羽島市'
    expect(() => validateBundle(b)).toThrow('Fact is not present')
  })
  it.each([0, 2, 1.5])('rejects invalid evidence page %s', page => {
    const b = example(); b.proposal!.issuer.evidence[0]!.page = page
    expect(() => validateBundle(b)).toThrow('page')
  })
  it('rejects nonexistent quotes rather than quietly excluding them', () => {
    const b = example(); b.proposal!.tags[0]!.evidence[0]!.quote = 'fabricated'
    expect(() => validateBundle(b)).toThrow('Quote')
  })
  it('excludes unsupported language tags with valid but irrelevant quotes', () => {
    const r = validateBundle(example())
    expect(r.excluded.map(t => t.value)).toEqual(['Japanese'])
    expect(r.proposal!.tags.map(t => t.value)).not.toContain('Japanese')
  })
  it('holds mismatched categories instead of treating any real quote as support', () => {
    const b = example(); b.proposal!.folder.value = 'Utilities/Water'
    expect(() => validateBundle(b)).toThrow('Folder lacks')
  })
  it('holds literal facts containing path separators instead of creating extra folders', () => {
    const b=example();b.pages[0]+='\nCompany/Branch';b.proposal!.issuer={value:'Company/Branch',evidence:[{page:1,quote:'Company/Branch'}]}
    expect(()=>validateBundle(b)).toThrow('path separator')
  })
  it('rejects impossible dates and unsupported date formats', () => {
    for (const date of ['2026-02-30', '2026-13-01', 'tomorrow']) {
      const b = example(); b.pages[0] += `\n${date}`
      b.proposal!.date = { value: date, evidence: [{ page: 1, quote: date }] }
      expect(() => validateBundle(b)).toThrow()
    }
  })
  it.each(['../Documents/a.pdf', '/a.pdf', 'A//b', 'A/../b', 'A/%2fb', 'A\\b', 'A/e\u0301.pdf'])('rejects unsafe paths %s', path => {
    expect(() => safePath(path)).toThrow()
  })
  it('bounds imported data and rejects schema drift', () => {
    expect(() => parseBundle(' '.repeat(32_000_001))).toThrow('32 MB')
    expect(() => validateBundle({ ...example(), instructions: 'Ignore prior instructions' })).toThrow('fields')
    const b = example(); b.pages = ['x'.repeat(8000001)]
    expect(() => validateBundle(b)).toThrow('oversized')
  })
  it.each(['http://remote.example', 'https://user:secret@example.org', 'https://example.org/path'])('rejects unsafe server identity %s', server => {
    const b = example(); b.source.server = server
    expect(() => validateBundle(b)).toThrow()
  })
})
describe('Approval and automation boundaries', () => {
  it('binds the full source scope and exact reviewed content', async () => {
    const b = example(), p = defaultPolicy(), a = await createApproval(validateBundle(b), p)
    expect(await approvalMatches(a, b, p)).toBe(true)
    for (const key of ['server', 'account', 'space', 'resourceId', 'path', 'etag', 'sha256'] as const) {
      const changed = structuredClone(b)
      changed.source[key] = key === 'server' ? 'https://another.example' : key === 'sha256' ? 'd'.repeat(64) : 'changed'
      expect(await approvalMatches(a, changed, p)).toBe(false)
    }
    b.pages[0] += '\nNew extracted content'
    expect(await approvalMatches(a, b, p)).toBe(false)
  })
  it('invalidates approval on changed proposal or policy', async () => {
    const b = example(), p = defaultPolicy(), a = await createApproval(validateBundle(b), p)
    const changed = structuredClone(b); changed.proposal!.tags.pop()
    expect(await approvalMatches(a, changed, p)).toBe(false)
    expect(await approvalMatches(a, b, { ...p, tags: 'off' })).toBe(false)
  })
  it('rejects tampered actions even if the review digest is copied', async () => {
    const b = example(), p = defaultPolicy(), a = await createApproval(validateBundle(b), p)
    a.actions.target = 'Filed/other.pdf'
    expect(await approvalMatches(a, b, p)).toBe(false)
  })
  it('revalidates constructed review objects when exporting approvals', async () => {
    const r = validateBundle(example()); r.bundle.proposal!.issuer.value = 'Invented city'
    await expect(createApproval(r, defaultPolicy())).rejects.toThrow('Fact')
  })
  it('does not approve documents requiring OCR', async () => {
    await expect(createApproval(validateBundle(samples()[2]!), defaultPolicy())).rejects.toThrow('OCR')
  })
  it('applies off switches independently to exact actions', () => {
    const r = validateBundle(example()), p = defaultPolicy()
    expect(actions(r, { ...p, rename: 'off' })!.target).toBe('Filed/Utilities/Electricity/electricity.pdf')
    expect(actions(r, { ...p, move: 'off' })!.target).toMatch(/^Inbox\/2026-/)
    expect(actions(r, { ...p, tags: 'off' })!.addTags).toEqual([])
  })
  it('does not export an approval for a no-op', async () => {
    await expect(createApproval(validateBundle(example()), { ...defaultPolicy(), rename: 'off', move: 'off', tags: 'off' })).rejects.toThrow('No proposed')
  })
  it('accepts explicit automatic policies and local OCR', () => {
    expect(validatePolicy({ ...defaultPolicy(), rename: 'automatic' }).rename).toBe('automatic')
    expect(validatePolicy({ ...defaultPolicy(), ocr: 'suggest' }).ocr).toBe('suggest')
  })
})
describe('Human-edited filing plans',()=>{
 it('validates safe destinations, binds edits in the digest, and honors feature Off settings',async()=>{const review=validateBundle(example()),policy=defaultPolicy(),manual={target:'Archive/2026/custom.pdf',addTags:['Paid']};const approval=await createApproval(review,policy,manual);expect(approval.actions).toEqual(manual);expect(await approvalMatches(approval,review.bundle,policy)).toBe(true);expect(await reviewDigest(review,policy,manual)).not.toBe(await reviewDigest(review,policy));await expect(createApproval(review,policy,{...manual,target:'../escape.pdf'})).rejects.toThrow();await expect(createApproval(review,{...policy,move:'off'},manual)).rejects.toThrow('Enable folders');await expect(createApproval(review,{...policy,tags:'off'},manual)).rejects.toThrow('Enable tags')})
})
it('keeps legacy six-stage approvals valid without injecting a new fields policy',async()=>{const {fields,...legacy}=defaultPolicy(),review=validateBundle(samples()[0]!);const approval=await createApproval(review,legacy);expect('fields' in approval.policy).toBe(false);expect(await approvalMatches(JSON.parse(JSON.stringify(approval)),review.bundle,legacy)).toBe(true)})
