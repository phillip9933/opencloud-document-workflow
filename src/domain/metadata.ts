// SPDX-License-Identifier: AGPL-3.0-only
import {printedDateISO,layoutSubstringSupported} from './languages.ts'
export interface FieldDefinition {id:string;label:string;type:'text'|'number'|'date'|'choice';aliases:string[];choices:string[]}
export interface TagRule {tag:string;terms:string[];match?:'substring'|'name'}
export interface MetadataSchema {fields:FieldDefinition[];tags:TagRule[]}
export const defaultMetadataSchema=():MetadataSchema=>({fields:[],tags:[]})
const str=(v:unknown,max=150):string=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f\x7f]/.test(v))throw new Error('Invalid metadata text');return v}
const exact=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))throw new Error('Unexpected metadata fields')}
export function validateMetadataSchema(value:MetadataSchema):MetadataSchema{
 exact(value,['fields','tags']);if(!Array.isArray(value.fields)||value.fields.length>40||!Array.isArray(value.tags)||value.tags.length>50)throw new Error('Too many metadata definitions')
 const ids=new Set<string>()
 const fields=value.fields.map(f=>{exact(f,['id','label','type','aliases','choices']);if(!/^[a-z][a-z0-9_]{0,39}$/.test(f.id)||ids.has(f.id)||['__proto__','constructor','prototype'].includes(f.id))throw new Error('Field IDs must be unique safe identifiers');ids.add(f.id);str(f.label);if(!['text','number','date','choice'].includes(f.type))throw new Error('Invalid field type');if(!Array.isArray(f.aliases)||f.aliases.length>20||!Array.isArray(f.choices)||f.choices.length>50)throw new Error('Invalid extraction rules');f.aliases.forEach(a=>str(a));f.choices.forEach(a=>str(a));if(f.type==='choice'&&!f.choices.length)throw new Error('Choice fields need options');return structuredClone(f)})
 const tags=value.tags.map(t=>{const hasMatch=Object.prototype.hasOwnProperty.call(t,'match');exact(t,hasMatch?['tag','terms','match']:['tag','terms']);str(t.tag,80);if(t.tag!==t.tag.normalize('NFC')||!Array.isArray(t.terms)||t.terms.length>30||hasMatch&&!['substring','name'].includes(t.match!))throw new Error('Invalid tag rule');t.terms.forEach(a=>str(a));return structuredClone(t)})
 if(new Set(tags.map(t=>t.tag)).size!==tags.length)throw new Error('Tag rules must be unique')
 return {fields,tags}
}
export function validateFieldValue(field:FieldDefinition,value:unknown):string|number{
 if(field.type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e15)throw new Error(`${field.label} needs a finite number`);return value}
 const s=str(value,2000)
 if(field.type==='choice'&&!field.choices.includes(s))throw new Error(`${field.label} needs a configured choice`)
 if(field.type==='date'){if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||printedDateISO(s)!==s)throw new Error(`${field.label} needs an ISO date`)}
 return s
}
export function validateValues(schema:MetadataSchema,values:Record<string,unknown>):Record<string,string|number>{
 if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(k=>!schema.fields.some(f=>f.id===k)))throw new Error('Unknown custom field')
 return Object.fromEntries(Object.entries(values).map(([id,value])=>[id,validateFieldValue(schema.fields.find(f=>f.id===id)!,value)]))
}
const normalizedName=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\p{Zs}\t]+/gu,' ').trim()
function singleHanMatcher(name:string){
 // A one-character name must not turn an ordinary compound into a person tag.
 const ending='(?=$|[^\\p{L}\\p{N}\\p{M}]|(?:様|さん|殿|氏)(?=$|[^\\p{L}\\p{N}\\p{M}]|[はがのへにとをも宛]))',standalone=new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${name}${ending}`,'u'),labelled=new RegExp(`^(?:氏名|お名前|name)(?:\\s*[:=]\\s*|\\s+)[^:=]*${name}${ending}`,'u')
 return(text:string)=>standalone.test(text)||labelled.test(text)
}
function nameMatcher(terms:string[]){
 const tests=terms.map(term=>{const name=normalizedName(term);if(/^\p{Script=Han}$/u.test(name))return singleHanMatcher(name);if(!/\p{Script=Latin}/u.test(name))return(text:string)=>text.includes(name)||layoutSubstringSupported(name,[text]);const literal=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(`(?<![\\p{Script=Latin}\\p{N}\\p{M}])${literal}(?![\\p{Script=Latin}\\p{N}\\p{M}])`,'u');return(text:string)=>pattern.test(text)})
 return(line:string)=>{const text=normalizedName(line);return tests.some(test=>test(text))}
}
export function suggestMetadata(schema:MetadataSchema,pages:string[]){
 validateMetadataSchema(schema)
 const fields:Record<string,{value:string|number;evidence:{page:number;quote:string}[]}>={},tags:{value:string;evidence:{page:number;quote:string}[]}[]=[]
 for(const field of schema.fields){const candidates=new Map<string,{value:string|number;evidence:{page:number;quote:string}[]}>()
  pages.forEach((page,index)=>page.split(/\r?\n/).forEach(line=>{for(const alias of field.aliases){const at=line.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase());if(at<0)continue;const prefix=line.slice(0,at).trim();if(prefix)continue;const rest=line.slice(at+alias.length);if(!/^\s*[:：=]/.test(rest))continue;const literal=rest.replace(/^\s*[:：=]\s*/,'').trim();try{const value=field.type==='number'?(/^[-+]?\d+(?:\.\d+)?$/.test(literal)?Number(literal):NaN):field.type==='date'?printedDateISO(literal):literal;const checked=validateFieldValue(field,value);candidates.set(JSON.stringify(checked),{value:checked,evidence:[{page:index+1,quote:line}]})}catch{}}}))
  if(candidates.size===1)fields[field.id]=[...candidates.values()][0]!
 }
 for(const rule of schema.tags){const matches=rule.match==='name'?nameMatcher(rule.terms):(line:string)=>rule.terms.some(term=>line.toLocaleLowerCase().includes(term.toLocaleLowerCase())),evidence:{page:number;quote:string}[]=[];pages.forEach((page,index)=>page.split(/\r?\n/).forEach(line=>{if(matches(line)&&evidence.length<8)evidence.push({page:index+1,quote:line})}));if(evidence.length)tags.push({value:rule.tag,evidence})}
 return {fields,tags}
}
