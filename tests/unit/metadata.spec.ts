import {validateMetadataSchema,validateValues,suggestMetadata} from '../../src/domain/metadata'
import type {MetadataSchema} from '../../src/domain/metadata'
const schema:MetadataSchema={fields:[{id:'invoice',label:'Invoice number',type:'text' as const,aliases:['Invoice number','請求番号'],choices:[]},{id:'amount',label:'Amount',type:'number' as const,aliases:['Amount'],choices:[]},{id:'due',label:'Due date',type:'date' as const,aliases:['Échéance'],choices:[]}],tags:[{tag:'Household',terms:['Electricity','電気']}]}
describe('configurable document fields',()=>{
 it('keeps manual person tags available without suggesting ownership from name mentions',()=>{const manual:MetadataSchema={fields:[],tags:[{tag:'Person: Sora',terms:[]},{tag:'Person: Alex',terms:[]},{tag:'Person: Haruka',terms:[]},{tag:'Warranty',terms:[]}]};expect(validateMetadataSchema(manual)).toEqual(manual);expect(suggestMetadata(manual,['Alex and Haruka accompanied Sora. Warranty information.']).tags).toEqual([])})
 it('extracts exact evidence with multilingual labels and typed dates',()=>{const r=suggestMetadata(schema,['請求番号： JP-42\nAmount: 120.50\nÉchéance: 29 octobre 2026\n電気料金']);expect(r.fields.invoice?.value).toBe('JP-42');expect(r.fields.amount?.value).toBe(120.5);expect(r.fields.due?.value).toBe('2026-10-29');expect(r.fields.invoice?.evidence[0]?.quote).toBe('請求番号： JP-42');expect(r.tags[0]?.value).toBe('Household')})
 it('holds conflicting facts and never guesses number conventions',()=>{const r=suggestMetadata(schema,['Invoice number: A\nInvoice number: B\nAmount: 1,200.50']);expect(r.fields).toEqual({})})
 it('rejects prototype keys, duplicate IDs, unknown fields, nonfinite numbers and bad dates',()=>{expect(()=>validateMetadataSchema({...schema,fields:[{...schema.fields[0]!,id:'constructor'}]})).toThrow();expect(()=>validateMetadataSchema({...schema,fields:[schema.fields[0]!,schema.fields[0]!]})).toThrow();expect(()=>validateValues(schema,{unknown:'x'})).toThrow();expect(()=>validateValues(schema,{amount:Infinity})).toThrow();expect(()=>validateValues(schema,{due:'2026-02-30'})).toThrow()})
})

describe('explicit name aliases for canonical person tags',()=>{
 const named=(terms:string[],tag='Person: Example'):MetadataSchema=>({fields:[],tags:[{tag,terms,match:'name'}]})
 it.each(['Alex','ALEX','alEx','Ａｌｅｘ','Alexさん','(Alex)',"Alex's"] )('matches case and width variants with Latin boundaries: %s',line=>{
  const result=suggestMetadata(named(['Alex']),[line]);expect(result.tags).toEqual([{value:'Person: Example',evidence:[{page:1,quote:line}]}])
 })
 it.each(['Alexanders','photoalex','Alex2','2Alex','Alexé','éAlex','Alex\u0307'])('does not confuse a Latin alias with part of a longer name or number: %s',line=>{
  expect(suggestMetadata(named(['Alex']),[line]).tags).toEqual([])
 })
 it.each(['Alexander James','ALEXANDER  JAMES','Alexander\tJames','Ａｌｅｘａｎｄｅｒ　Ｊａｍｅｓ'])('normalizes horizontal spacing inside an explicit multiword alias: %s',line=>{
  expect(suggestMetadata(named(['Alexander James']),[line]).tags[0]?.value).toBe('Person: Example')
 })
 it.each(['Alexander Jamesathan','AlexanderJohn','Alexander\nJames'])('does not invent a multiword alias from another name or separate lines: %s',line=>{
  expect(suggestMetadata(named(['Alexander James']),[line]).tags).toEqual([])
 })
 it('maps English, hiragana and full/half-width katakana aliases to one canonical tag with original evidence',()=>{
  const lines=['Alex (あれっくす / アレックス)','Alexander James / アレクサンダー','ｱﾚｸｻﾝﾀﾞｰさん'],result=suggestMetadata(named(['Alex','Alexander','Alexander James','あれっくす','アレックス','あれくさんだー','アレクサンダー']),[lines.join('\n')])
  expect(result.tags).toEqual([{value:'Person: Example',evidence:lines.map(quote=>({page:1,quote}))}])
 })
 it('keeps each canonical tag separate while recognizing Japanese aliases within names and suffixes',()=>{
  const configuration:MetadataSchema={fields:[],tags:[{tag:'Person: A',terms:['Haruka','はるか','ハルカ'],match:'name'},{tag:'Person: B',terms:['Sora','そら','ソラ'],match:'name'}]},line='はるか様、ソラさん、HARUKA、Sora'
  expect(suggestMetadata(configuration,[line]).tags).toEqual([{value:'Person: A',evidence:[{page:1,quote:line}]},{value:'Person: B',evidence:[{page:1,quote:line}]}])
 })
 it.each(['A+B','A.B','A[B]','A(B)','(a+)+$'])('treats regular-expression characters in aliases as literal text: %s',alias=>{
  expect(suggestMetadata(named([alias]),['Name: '+alias]).tags[0]?.value).toBe('Person: Example')
  expect(suggestMetadata(named([alias]),['Name: AAB aaa']).tags).toEqual([])
 })
 it('preserves legacy substring rules and their serialized shape while keeping empty aliases manual',()=>{
  const legacy:MetadataSchema={fields:[],tags:[{tag:'Legacy',terms:['Alex']}]},explicit:MetadataSchema={fields:[],tags:[{tag:'Explicit',terms:['Alex'],match:'substring'}]}
  expect(JSON.stringify(validateMetadataSchema(legacy))).toBe(JSON.stringify(legacy));expect(suggestMetadata(legacy,['Alexanders']).tags[0]?.value).toBe('Legacy');expect(suggestMetadata(legacy,['Ａｌｅｘ']).tags).toEqual([]);expect(suggestMetadata(explicit,['Alexanders']).tags[0]?.value).toBe('Explicit');expect(suggestMetadata(named([]),['Alex アレックス']).tags).toEqual([])
 })
 it('rejects unsupported matching modes and unknown tag properties',()=>{
  for(const extra of [{match:'word'},{match:undefined},{match:'name',guess:true}])expect(()=>validateMetadataSchema({fields:[],tags:[{tag:'Example',terms:['Name'],...extra}]} as MetadataSchema)).toThrow()
 })
})

describe('conservative one-character Han name aliases',()=>{
 const single:MetadataSchema={fields:[],tags:[{tag:'Person: Example',terms:['葵'],match:'name'}]}
 it.each(['葵','「葵」','葵様','葵さんの書類','葵殿','葵氏','氏名: 田中葵','お名前：田中葵様','Name: Tanaka葵','氏名 田中葵'])('accepts a clear standalone, honorific or name-labelled occurrence: %s',line=>{
  expect(suggestMetadata(single,[line]).tags).toEqual([{value:'Person: Example',evidence:[{page:1,quote:line}]}])
 })
 it.each(['葵祭','葵祭の案内','催事: 葵祭','田中葵','田中葵様','葵氏名','氏名: 葵祭','商品名: 田中葵','Name: 葵祭','葵2','2葵'])('does not tag compounds or unlabelled embedded names: %s',line=>{
  expect(suggestMetadata(single,[line]).tags).toEqual([])
 })
})
