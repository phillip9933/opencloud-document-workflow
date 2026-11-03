import {defaultFilingRules,validateFilingRules,taxYearFromPages} from '../../src/domain/filing'
import type {FolderClassificationRule} from '../../src/domain/filing'
import {samples} from '../../src/domain/samples'
import {validateBundle,actions,defaultPolicy,createApproval,approvalMatches,reviewDigest} from '../../src/domain/review'
it('uses configurable categories and year/month naming with evidence and binds the rules to approval',async()=>{
 const rules=defaultFilingRules();rules.root='Archive';rules.folderTemplate='{year}/{category}';rules.nameTemplate='{date} {original}.pdf';rules.folders.push({value:'Household/Power',terms:['Electricity'],match:'word'});rules.tags.push({value:'Home',terms:['Electricity'],match:'word'})
 const bundle={...samples()[0]!,rules};bundle.proposal=structuredClone(bundle.proposal!);bundle.proposal.folder={value:'Household/Power',evidence:[{page:1,quote:'Electricity invoice'}]};bundle.proposal.tags=[{value:'Home',evidence:[{page:1,quote:'Electricity invoice'}]}]
 const review=validateBundle(bundle),policy=defaultPolicy();expect(actions(review,policy)).toEqual({target:'Archive/2026/Household/Power/2026-10-29 electricity.pdf',addTags:['Home']});const approval=await createApproval(review,policy);expect(await approvalMatches(approval,bundle,policy)).toBe(true);bundle.rules={...rules,root:'Different'};expect(await approvalMatches(approval,bundle,policy)).toBe(false)
 bundle.proposal.folder.evidence=[{page:1,quote:'SYNTHETIC DOCUMENT'}];expect(()=>validateBundle(bundle)).toThrow('supporting evidence')
})
it('accepts documents beyond the former fifty-page fixture bound without dropping extracted pages',()=>{const bundle=samples()[0]!;bundle.pages=[...bundle.pages,...Array(70).fill('Additional document page')];expect(validateBundle(bundle).bundle.pages).toHaveLength(71)})
it('rejects traversal, unsupported template tokens and invalid custom evidence rules',()=>{for(const patch of [{root:'../Archive'},{nameTemplate:'{command}.pdf'},{folderTemplate:'{issuer}'},{folders:[] as ReturnType<typeof defaultFilingRules>['folders']}])expect(()=>validateFilingRules({...defaultFilingRules(),...patch})).toThrow()})
it('applies a unique explicit category rule when AI returns Other and reports competing rules',()=>{const rules=defaultFilingRules();rules.folders=[{value:'Home/Power',terms:['Electricity'],match:'word'},{value:'Other',terms:[],match:'word'}];const bundle={...samples()[0]!,rules};bundle.proposal=structuredClone(bundle.proposal!);bundle.proposal.folder.value='Other';const review=validateBundle(bundle);expect(review.proposal!.folder.value).toBe('Home/Power');expect(review.ruleMatch).toBe('Home/Power');expect(review.proposal!.folder.evidence[0]!.quote).toContain('Electricity');rules.folders.push({value:'Finance',terms:['invoice'],match:'word'});const conflict=validateBundle(bundle);expect(conflict.ruleAmbiguous).toBe(true);expect(conflict.proposal!.folder.value).toBe('Other')})

function categoryBundle(row:FolderClassificationRule,lines:string[]=[]){
 const rules=defaultFilingRules();rules.root='Archive';rules.folders=[row,{value:'Other',terms:[],match:'word'}]
 const bundle={...samples()[0]!,rules};bundle.pages[0]+='\n'+[row.terms[0]!,...lines].join('\n');bundle.proposal=structuredClone(bundle.proposal!)
 bundle.proposal.folder={value:row.value,evidence:[{page:1,quote:row.terms[0]!}]};return bundle
}
const taxRule=():FolderClassificationRule=>({value:'Taxes/United States',terms:['Tax return'],match:'word',folderTemplate:'{category}/{taxYear}',taxYearLabels:['Tax year','対象年']})
it('preserves the exact pre-extension digest and omits absent category options',async()=>{
 const rules=defaultFilingRules(),checked=validateFilingRules(rules)
 expect(JSON.stringify(checked)).toBe(JSON.stringify(rules));expect(checked.folders.every(row=>!('folderTemplate' in row)&&!('taxYearLabels' in row))).toBe(true)
 // Computed independently from the frozen 0.13.0 corresponding source package.
 expect(await reviewDigest(validateBundle({...samples()[0]!,rules}),defaultPolicy())).toBe('b6eaf48132795946bdd4fb9d91bc5e38b696b635bbf1e2c4ad04626a6c4a929e')
})
it('adds document-year folders only to the category with an override',()=>{
 const receipt=categoryBundle({value:'Receipts',terms:['Purchase receipt'],match:'word',folderTemplate:'{category}/{year}'})
 expect(actions(validateBundle(receipt),defaultPolicy())!.target).toContain('Archive/Receipts/2026/')
 const utility={...samples()[0]!,rules:defaultFilingRules()};utility.rules.folders.push(receipt.rules.folders[0]!)
 expect(actions(validateBundle(utility),defaultPolicy())!.target).toContain('Filed/Utilities/Electricity/')
 expect(actions(validateBundle(utility),defaultPolicy())!.target).not.toContain('/2026/')
})
it('uses an explicit tax year rather than the later printed document year and binds its rules to approval',async()=>{
 const bundle=categoryBundle(taxRule(),['Tax year: 2025']),policy=defaultPolicy(),review=validateBundle(bundle),approval=await createApproval(review,policy)
 expect(approval.actions.target).toContain('Archive/Taxes/United States/2025/2026-10-29 ')
 expect(await approvalMatches(approval,bundle,policy)).toBe(true)
 const changed=structuredClone(bundle);changed.rules.folders[0]!.taxYearLabels=['対象年']
 await expect(approvalMatches(approval,changed,policy)).rejects.toThrow('tax year')
 const changedPages=structuredClone(bundle);changedPages.pages[0]=changedPages.pages[0]!.replace('Tax year: 2025','Tax year: 2024')
 expect(await approvalMatches(approval,changedPages,policy)).toBe(false)
})
it.each(['Tax year: 2025','Tax year 2025','Tax year\t2025','Tax year：２０２５','対象年：２０２５年','Tax year: 2025\n対象年: 2025'])('recognizes only an explicitly labelled Gregorian tax year: %s',line=>{
 expect(taxYearFromPages([line],['Tax year','対象年'])).toBe('2025')
})
it.each(['Document date: 2025-01-01','Tax yearly 2025','Tax year: 0000','Tax year: 2025-01-01','Tax year: 2025/2026','Tax year: 2025.12.31','Tax year: 2025 12 31','Tax year: 2025 to 2026','Tax year: 2025, 2026','Tax year: 2025 2026','Tax year: 2025年12月1日','Tax year: 2025 年12月1日','Tax year: 令和7年','Tax year: 2025\nTax year: 2024','Tax year: 2025\nTax year: unknown'])('holds missing, conflicting, era, range or date-shaped tax years: %s',line=>{
 expect(()=>taxYearFromPages([line],['Tax year'])).toThrow('tax year')
})
it('does not resolve a tax-year folder while movement is disabled and permits an explicitly reviewed manual target',async()=>{
 const bundle=categoryBundle(taxRule()),review=validateBundle(bundle),policy=defaultPolicy()
 expect(()=>actions(review,policy)).toThrow('tax year')
 expect(actions(review,{...policy,move:'off'})!.target).toMatch(/^Inbox\//)
 const manual={target:'Archive/Taxes/United States/2025/reviewed.pdf',addTags:[] as string[]},approval=await createApproval(review,policy,manual)
 expect(approval.actions).toEqual(manual);expect(await approvalMatches(approval,bundle,policy)).toBe(true)
})
it('rejects unsafe category patterns, absent tax labels and tag pattern options',()=>{
 for(const patch of [{folderTemplate:'../{category}'},{folderTemplate:'{category}/{issuer}'},{folderTemplate:'{category}/{taxYear}'},{folderTemplate:'{category}/{taxYear}',taxYearLabels:[]},{folderTemplate:'{category}/{taxYear}',taxYearLabels:['Tax year','Ｔａｘ ｙｅａｒ']},{folderTemplate:'{category}',taxYearLabels:['Tax year']},{folderTemplate:'{category}/{taxYear}',taxYearLabels:['2025']}]){
  const bundle=categoryBundle({...taxRule(),taxYearLabels:undefined,...patch});if(!('taxYearLabels' in patch))delete bundle.rules.folders[0]!.taxYearLabels
  expect(()=>validateFilingRules(bundle.rules)).toThrow()
 }
 const rules=defaultFilingRules();Object.assign(rules.tags[0]!,{folderTemplate:'{category}/{year}'});expect(()=>validateFilingRules(rules)).toThrow('classification rule')
})
it('recognizes spaced CJK headings with exact source evidence, without joining English words, digits or separate lines',async()=>{
 const {ruleSupported}=await import('../../src/domain/filing'),rules=defaultFilingRules();rules.folders=[{value:'Vehicles',terms:['自動車検査証'],match:'substring'},{value:'Other',terms:[],match:'word'}];const printed='自 動 車 検 査 証 記 録 事 項';expect(ruleSupported('Vehicles',[printed],rules.folders,rules)).toBe(true);expect(ruleSupported('Vehicles',['自動車\n検査証'],rules.folders,rules)).toBe(false);expect(ruleSupported('Vehicles',['自動車','検査証'],rules.folders,rules)).toBe(false);expect(ruleSupported('Vehicles',['目 動 車 検 査 証'],rules.folders,rules)).toBe(false);rules.folders[0]!.terms=['gas'];expect(ruleSupported('Vehicles',['getting a sample'],rules.folders,rules)).toBe(false)
 rules.folders[0]!.terms=['自動車検査証'];const bundle={...samples()[0]!,rules};bundle.pages[0]+='\n'+printed;bundle.proposal=structuredClone(bundle.proposal!);bundle.proposal.folder={value:'Vehicles',evidence:[{page:1,quote:printed}]};bundle.proposal.tags=[];expect(validateBundle(bundle).proposal!.folder.evidence[0]!.quote).toBe(printed)
})
