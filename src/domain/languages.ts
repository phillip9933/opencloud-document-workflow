// SPDX-License-Identifier: AGPL-3.0-only
import catalog from './language-packs/catalog.json' with {type:'json'}
export interface LanguagePack {
  id:string;version:number;name:string;dates:string[];months:Record<string,number>;terms:Record<string,string[]>
  digits?:string[]
  termMatch?:'word'|'substring'
  examples:{field:string;quote:string;value:string}[]
}
export interface LanguageProfile {packs:LanguagePack[]}
export function languageProfile(packs:LanguagePack[]):LanguageProfile {
  if(!Array.isArray(packs)||packs.length>100)throw new Error('Invalid language profile')
  const seen=new Set<string>()
  for(const pack of packs){
    if(!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(pack.id)||seen.has(pack.id)||!Number.isInteger(pack.version)||pack.version<1)throw new Error('Invalid or duplicate language pack')
    seen.add(pack.id)
    if(pack.termMatch&&!['word','substring'].includes(pack.termMatch))throw new Error('Invalid category matching mode')
    if(!Array.isArray(pack.dates)||pack.dates.length>20||pack.dates.some(v=>typeof v!=='string'||v.length>100))throw new Error('Invalid date patterns')
    for(const pattern of pack.dates){const tokens=pattern.match(/\{[^}]+\}/g)||[];if(tokens.filter(t=>t==='{year}').length!==1||tokens.filter(t=>t==='{day}').length!==1||tokens.filter(t=>t==='{month}'||t==='{monthName}').length!==1||tokens.length!==3)throw new Error('Date patterns need year, month and day tokens')}
    if(pack.digits&&(!Array.isArray(pack.digits)||pack.digits.length>10||pack.digits.some(d=>typeof d!=='string'||Array.from(d).length!==10||new Set(Array.from(d)).size!==10)))throw new Error('Digit sets must contain ten distinct decimal digits')
    if(pack.dates.some(p=>p.includes('{monthName}'))&&!Object.keys(pack.months).length)throw new Error('Named-month rules need month aliases')
    for(const [name,month] of Object.entries(pack.months)){if(!name||name.length>60||!Number.isInteger(month)||month<1||month>12)throw new Error('Invalid month alias')}
    for(const [id,terms] of Object.entries(pack.terms)){if(!id.trim()||id.length>150||/[\x00-\x1f\x7f]/.test(id)||!Array.isArray(terms)||terms.length>100||terms.some(t=>typeof t!=='string'||!t.trim()||t.length>100))throw new Error('Invalid category terms')}
  }
  return {packs:JSON.parse(JSON.stringify(packs)) as LanguagePack[]}
}
export const defaultLanguageProfile=languageProfile(catalog as LanguagePack[])
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
// Unicode decimal blocks allow localized digits without changing the preserved source fact.
const zeroes=[0x30,0x660,0x6f0,0x7c0,0x966,0x9e6,0xa66,0xae6,0xb66,0xbe6,0xc66,0xce6,0xd66,0xe50,0xed0,0xf20,0x1040,0x17e0,0x1810,0xff10]
function normalize(s:string,profile=defaultLanguageProfile){const custom=Object.fromEntries(profile.packs.flatMap(p=>(p.digits||[]).flatMap(set=>Array.from(set).map((digit,n)=>[digit.normalize('NFKC'),String(n)]))));return Array.from(s.normalize('NFKC')).map(c=>{if(custom[c]!==undefined)return custom[c];const n=c.codePointAt(0)!;const zero=zeroes.find(z=>n>=z&&n<z+10);return zero===undefined?c:String(n-zero)}).join('').toLowerCase()}
export function printedDateISO(raw:string,profile=defaultLanguageProfile):string {
 const candidates=new Set<string>();let matched=false
 for(const pack of profile.packs){
  const months=Object.fromEntries(Object.entries(pack.months).map(([name,n])=>[normalize(name,profile),n]))
  for(const pattern of pack.dates){
   const fields:string[]=[];let regex='',last=0
   for(const token of pattern.matchAll(/\{(year|month|day|monthName)\}/g)){
    regex+=escape(normalize(pattern.slice(last,token.index),profile));const field=token[1]!;fields.push(field)
    regex+=field==='monthName'?'('+Object.keys(months).sort((a,b)=>b.length-a.length).map(escape).join('|')+')':field==='year'?'([0-9]{4})':'([0-9]{1,2})'
    last=token.index+token[0].length
   }
   regex+=escape(normalize(pattern.slice(last),profile))
   const match=new RegExp('^'+regex+'$','u').exec(normalize(raw,profile));if(!match)continue;matched=true
   const values:Record<string,number>={};fields.forEach((f,i)=>{values[f==='monthName'?'month':f]=f==='monthName'?months[match[i+1]!]!:Number(match[i+1])})
   const iso=`${String(values.year).padStart(4,'0')}-${String(values.month).padStart(2,'0')}-${String(values.day).padStart(2,'0')}`
   const date=new Date(iso+'T00:00:00Z');if(Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso)candidates.add(iso)
  }
 }
 if(candidates.size>1)throw new Error('Ambiguous printed date; review the date convention explicitly')
 if(!candidates.size)throw new Error(matched?'Invalid calendar date':'Unsupported printed date format; add an explicit language/date rule')
 return [...candidates][0]!
}
export function categorySupported(id:string,quotes:string[],profile=defaultLanguageProfile){
 const text=normalize(quotes.join(' '),profile)
 return profile.packs.some(pack=>(pack.terms[id]||[]).some(term=>{
  const cue=normalize(term,profile)
  return pack.termMatch==='substring'?text.includes(cue):new RegExp('(?<![\\p{L}\\p{N}\\p{M}])'+escape(cue)+'(?![\\p{L}\\p{N}\\p{M}])','u').test(text)
 }))
}
export function languageInstructions(profile=defaultLanguageProfile){return JSON.stringify({dateFormats:[...new Set(profile.packs.flatMap(p=>p.dates))],categoryTerms:profile.packs.map(p=>({locale:p.id,terms:p.terms})),fieldExamples:profile.packs.flatMap(p=>p.examples)})}
