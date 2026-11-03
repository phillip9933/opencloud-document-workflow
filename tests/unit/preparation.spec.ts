// SPDX-License-Identifier: AGPL-3.0-only
import {samples} from '../../src/domain/samples'
import {inspectProposal,validateBundle,actions,defaultPolicy} from '../../src/domain/review'
import {preparationReview} from '../../src/domain/preparation'
it('retains only independently verified fields when a date cannot be supported',()=>{
 const bundle=samples()[0]!,input={schemaVersion:bundle.schemaVersion,source:bundle.source,pages:bundle.pages},raw=structuredClone(bundle.proposal!)
 raw.date.value='2099-12-31'
 const report=inspectProposal(input,raw)
 expect(report.verified.issuer?.value).toBe(raw.issuer.value);expect(report.verified.kind?.value).toBe(raw.kind.value);expect(report.verified.date).toBeUndefined();expect(report.issues).toContainEqual({field:'date',code:'literal'})
 const manual=validateBundle({...input,proposal:null,manualReview:{reason:'evidence'}})
 expect(actions(manual,defaultPolicy())).toBeNull();expect(manual.proposal).toBeNull()
})
it('does not retain a supported-looking value with invented evidence or an incomplete date',()=>{
 const bundle=samples()[0]!,input={schemaVersion:bundle.schemaVersion,source:bundle.source,pages:bundle.pages},raw=structuredClone(bundle.proposal!)
 raw.issuer.evidence=[{page:1,quote:'An invented quotation'}];raw.date={value:'2026',evidence:[{page:1,quote:bundle.pages[0]!}]}
 const report=inspectProposal(input,raw)
 expect(report.verified.issuer).toBeUndefined();expect(report.verified.date).toBeUndefined();expect(report.issues.map(i=>i.field)).toEqual(expect.arrayContaining(['issuer','date']));expect(report.verified.kind).toBeDefined()
})
it('handles routed responses without accepting malformed or extra AI fields',()=>{
 const bundle=samples()[0]!,input={schemaVersion:bundle.schemaVersion,source:bundle.source,pages:bundle.pages}
 expect(preparationReview(input,{route:{provider:'local'},proposal:bundle.proposal}).verified.issuer).toBeDefined()
 expect(inspectProposal(input,{...bundle.proposal,command:'ignore checks'})).toEqual({verified:{},issues:[{field:'document',code:'shape'}]})
})
it('separates a rejected category from verified document facts',()=>{
 const bundle=samples()[0]!,input={schemaVersion:bundle.schemaVersion,source:bundle.source,pages:bundle.pages},raw=structuredClone(bundle.proposal!)
 raw.folder.value='Not configured'
 const report=inspectProposal(input,raw)
 expect(report.verified.folder).toBeUndefined();expect(report.verified.date).toBeDefined();expect(report.issues).toContainEqual({field:'folder',code:'category'})
})
it('offers only complete literal date passages, leaving damaged OCR and ambiguous dates uncorrected',async()=>{
 const{documentDateCandidates}=await import('../../src/domain/review')
 const source=samples()[0]!.source,input={schemaVersion:1 as const,source,pages:['記録日 令和8年10月29 a\n登録 令和8年10月29日 新規登録\nUnknown 10/11/2026\nInvalid 2026-02-30']}
 const before=JSON.stringify(input),candidates=documentDateCandidates(input)
 expect(candidates).toHaveLength(1);expect(candidates[0]!.value).toBe('令和8年10月29日');expect(candidates[0]!.evidence).toEqual([{page:1,quote:'登録 令和8年10月29日 新規登録'}]);expect(JSON.stringify(input)).toBe(before)
})
it('represents an absent AI value explicitly without manufacturing a replacement',()=>{
 const bundle=samples()[0]!,input={schemaVersion:bundle.schemaVersion,source:bundle.source,pages:bundle.pages}
 const report=inspectProposal(input,{...bundle.proposal,date:null})
 expect(report.verified.date).toBeUndefined();expect(report.issues).toContainEqual({field:'date',code:'missing'});expect(report.verified.issuer).toBeDefined()
})
it('does not replace an invented AI category citation with a matching rule elsewhere',async()=>{
 const{defaultFilingRules}=await import('../../src/domain/filing'),bundle=samples()[0]!,rules=defaultFilingRules();rules.folders[0]!.terms=['Electricity invoice']
 const input={schemaVersion:bundle.schemaVersion,source:bundle.source,pages:bundle.pages,rules},raw=structuredClone(bundle.proposal!);raw.tags=[];raw.folder.evidence=[{page:1,quote:'An invented category citation'}]
 expect(()=>validateBundle({...input,proposal:raw})).toThrow('Quote is absent');const report=inspectProposal(input,raw);expect(report.verified.folder).toBeUndefined();expect(report.verified.issuer).toBeDefined();expect(report.issues).toContainEqual({field:'folder',code:'quote'})
})
