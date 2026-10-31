import {defaultLanguageProfile,languageProfile,printedDateISO,categorySupported} from '../../src/domain/languages'
import {validateBundle,filename} from '../../src/domain/review'
import {samples} from '../../src/domain/samples'
import type {LanguagePack} from '../../src/domain/languages'
describe('Extensible document language rules',()=>{
 it('processes a third language without changing the review engine',()=>{
  const b=samples()[0]!,claim=(value:string,quote=value)=>({value,evidence:[{page:1,quote}]})
  b.pages=['Émetteur : Société Exemple\nDate : 29 octobre 2026\nType : Facture d’électricité']
  b.proposal={issuer:claim('Société Exemple'),date:claim('29 octobre 2026'),kind:claim('Facture d’électricité'),folder:claim('Utilities/Electricity','Facture d’électricité'),tags:[claim('Electricity','Facture d’électricité'),claim('Invoice','Facture d’électricité')]}
  const r=validateBundle(b);expect(filename(r.proposal!)).toBe('2026-10-29 Société Exemple Facture d’électricité.pdf')
  expect(r.proposal!.tags.map(t=>t.value)).toEqual(['Electricity','Invoice'])
 })
 it('adds another script with a data-only pack and preserves exact factual text',()=>{
  const ar:LanguagePack={id:'ar',version:1,name:'Arabic test pack',dates:['{day} {monthName} {year}'],months:{'أكتوبر':10},terms:{'Utilities/Water':['مياه'],Water:['مياه'],Invoice:['فاتورة']},examples:[]}
  const profile=languageProfile([...defaultLanguageProfile.packs,ar])
  expect(printedDateISO('٢٩ أكتوبر ٢٠٢٦',profile)).toBe('2026-10-29')
  expect(()=>printedDateISO('٢٩ أكتوبر ٢٠٢٦')).toThrow('Unsupported')
 })
 it('extends decimal digit scripts through data rather than a core-code change',()=>{
  const digits=Array.from({length:10},(_,i)=>String.fromCodePoint(0x1090+i)).join('')
  const pack:LanguagePack={id:'my-Shan',version:1,name:'Shan digits test',dates:['{year}.{month}.{day}'],months:{},digits:[digits],terms:{},examples:[]}
  const raw='2026.10.29'.replace(/[0-9]/g,d=>Array.from(digits)[Number(d)]!)
  expect(printedDateISO(raw,languageProfile([...defaultLanguageProfile.packs,pack]))).toBe('2026-10-29')
 })
 it('does not mistake a substring in an unrelated word for French water evidence',()=>{
  expect(categorySupported('Water',['bureau'])).toBe(false)
  expect(categorySupported('Water',['Facture d’eau'])).toBe(true)
  expect(categorySupported('Water',['水道料金請求書'])).toBe(true)
 })
 it('holds ambiguous numeric dates rather than assuming a document language',()=>{
  expect(()=>printedDateISO('03/04/2026')).toThrow('Ambiguous')
  expect(printedDateISO('29/10/2026')).toBe('2026-10-29')
  expect(printedDateISO('10/29/2026')).toBe('2026-10-29')
  expect(printedDateISO('10/10/2026')).toBe('2026-10-10')
 })
 it('keeps calendar validation and unsupported-date holds across languages',()=>{
  expect(()=>printedDateISO('31 février 2026')).toThrow('Invalid calendar')
  expect(()=>printedDateISO('next Thursday')).toThrow('Unsupported')
 })
 it('rejects duplicate or malformed language rules',()=>{
  expect(()=>languageProfile([...defaultLanguageProfile.packs,defaultLanguageProfile.packs[0]!])).toThrow('duplicate')
  const b=structuredClone(defaultLanguageProfile.packs[1]!);b.dates=['{year}/{month}'];expect(()=>languageProfile([b])).toThrow('tokens')
 })
})
