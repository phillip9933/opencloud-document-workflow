// SPDX-License-Identifier: AGPL-3.0-only
import{documentFingerprint as fingerprint,compareFingerprints as compare}from'../../src/domain/similarity'
const base=(date='2026-10-29',amount='123.45')=>`SYNTHETIC invoice\nIssue date ${date}\nAccount A123456789012345\nReference B987654321098765\nTotal $${amount}\n`+'Example services supplied to this account. Detailed description and payment terms. '.repeat(8)
it('flags differently scanned copies only with corroborating identifiers, date and unchanged amounts',()=>{
 const a=fingerprint([base()]),b=fingerprint([base().replace('Detailed description','Detai1ed description').replace('payment terms','payment  terms')])
 expect(compare(a,b).candidate).toBe(true)
})
it('keeps monthly bills and changed amounts separate despite an identical template and account',()=>{
 expect(compare(fingerprint([base()]),fingerprint([base('2026-11-29')])).candidate).toBe(false)
 expect(compare(fingerprint([base()]),fingerprint([base('2026-10-29','999.45')])).candidate).toBe(false)
})
it('requires a printed date and identifiers, never similarity alone',()=>{
 expect(compare(fingerprint([base().replace('2026-10-29','October')]),fingerprint([base().replace('2026-10-29','October')])).candidate).toBe(false)
 expect(compare(fingerprint([base().replace(/[AB]\d{15}/g,'ordinary text')]),fingerprint([base().replace(/[AB]\d{15}/g,'ordinary text')])).candidate).toBe(false)
 expect(compare(null,fingerprint([base()])).candidate).toBe(false)
})
it('uses configured date conventions and preserves recurring integer-currency bills',()=>{
 expect(compare(fingerprint([base().replace('$123.45','1234円')]),fingerprint([base().replace('$123.45','2345円')])).candidate).toBe(false)
})
it('can compare a scan missing an expiry date, but holds conflicting dates on repeated bills',()=>{
 const original=fingerprint([base()]),withExpiry=fingerprint([base()+'\nExpires 2030-10-29'])
 expect(compare(original,withExpiry).candidate).toBe(true)
 const first=fingerprint([base()+'\nAccount opened 2020-01-01']),next=fingerprint([base('2026-11-29')+'\nAccount opened 2020-01-01'])
 expect(compare(first,next).candidate).toBe(false)
})

it('keeps changed integer currency-code amounts separate, including code-before and code-after layouts',()=>{
 const a=base().replace('$123.45','USD 100'),same=base().replace('$123.45','100 USD'),changed=base().replace('$123.45','USD 200');expect(compare(fingerprint([a]),fingerprint([same])).candidate).toBe(true);expect(compare(fingerprint([a]),fingerprint([changed])).candidate).toBe(false);expect(compare(fingerprint([base().replace('$123.45','100 JPY')]),fingerprint([base().replace('$123.45','200 JPY')])).candidate).toBe(false)
})
it('does not interpret ordinary mixed-case words as ISO currencies in OCR text',()=>{
 const original=base(),scan=original+'\nAll 7 copies enclosed.'
 expect(fingerprint([scan])?.amounts).toEqual(fingerprint([original])?.amounts)
 expect(compare(fingerprint([original]),fingerprint([scan])).candidate).toBe(true)
 expect(compare(fingerprint([base().replace('$123.45','ALL 7')]),fingerprint([base().replace('$123.45','ALL 8')])).candidate).toBe(false)
})
