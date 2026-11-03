// SPDX-License-Identifier: AGPL-3.0-only
import {defaultLanguageProfile,languageProfile,categorySupported,layoutSubstringSupported} from './languages.ts'
import type {LanguagePack} from './languages.ts'
import {safePath} from './review.ts'
export interface ClassificationRule {value:string;terms:string[];match:'word'|'substring'}
export interface FolderClassificationRule extends ClassificationRule {folderTemplate?:string;taxYearLabels?:string[]}
export interface FilingRules {root:string;folderTemplate:string;nameTemplate:string;folders:FolderClassificationRule[];tags:ClassificationRule[];languages:LanguagePack[]}
const rule=(value:string):ClassificationRule=>({value,terms:[],match:'word'})
export const defaultFilingRules=():FilingRules=>({root:'Filed',folderTemplate:'{category}',nameTemplate:'{date} {issuer} {kind}.pdf',folders:['Utilities/Electricity','Utilities/Water','Finance','Correspondence','Other'].map(rule),tags:['Electricity','Water','Invoice','Synthetic'].map(rule),languages:[]})
function validateTemplate(template:string,allowed:readonly string[]){
 if(typeof template!=='string'||!template.trim()||template.length>400||/[\x00-\x1f\x7f]/.test(template))throw new Error('Invalid filing template')
 const remaining=template.replace(/\{([^}]+)\}/g,(_,key)=>{if(!allowed.includes(key))throw new Error('Unknown filing template token: '+key);return 'example'})
 if(/[{}]/.test(remaining))throw new Error('Invalid filing template token');safePath(remaining)
}
export function validateFilingRules(value:FilingRules):FilingRules{
 if(!value||Object.keys(value).sort().join(',')!=='folderTemplate,folders,languages,nameTemplate,root,tags')throw new Error('Unexpected filing settings')
 safePath(value.root)
 for(const [template,allowed] of [[value.folderTemplate,['category','year','month','day']],[value.nameTemplate,['date','issuer','kind','original','year','month','day','resource']]] as const){
  validateTemplate(template,allowed)
 }
 if(value.nameTemplate.includes('/')||!value.nameTemplate.toLowerCase().endsWith('.pdf'))throw new Error('Filename template must be one PDF filename')
 for(const [key,max] of [['folders',200],['tags',50]] as const){const rows=value[key];if(!Array.isArray(rows)||!rows.length&&key==='folders'||rows.length>max||new Set(rows.map(r=>r?.value)).size!==rows.length)throw new Error('Invalid or duplicate classification rules');for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Invalid classification rule');const allowed=key==='folders'?['match','terms','value',...('folderTemplate' in row?['folderTemplate']:[]),...('taxYearLabels' in row?['taxYearLabels']:[])].sort().join(','):'match,terms,value';if(Object.keys(row).sort().join(',')!==allowed||typeof row.value!=='string'||!row.value.trim()||row.value.length>(key==='tags'?80:150)||row.value!==row.value.normalize('NFC')||/[\x00-\x1f\x7f]/.test(row.value)||!['word','substring'].includes(row.match)||!Array.isArray(row.terms)||row.terms.length>100||row.terms.some(t=>typeof t!=='string'||!t.trim()||t.length>150))throw new Error('Invalid classification rule');if(key==='folders'){
  safePath(row.value);const folder=row as FolderClassificationRule
  if('folderTemplate' in folder)validateTemplate(folder.folderTemplate!,['category','year','month','day','taxYear'])
  const usesTaxYear=folder.folderTemplate?.includes('{taxYear}')??false
  if(usesTaxYear||'taxYearLabels' in folder){if(!usesTaxYear||!Array.isArray(folder.taxYearLabels)||!folder.taxYearLabels.length||folder.taxYearLabels.length>20||new Set(folder.taxYearLabels.map(label=>typeof label==='string'?label.normalize('NFKC').toLowerCase():label)).size!==folder.taxYearLabels.length||folder.taxYearLabels.some(label=>typeof label!=='string'||label!==label.trim()||!label.length||label.length>150||!/[\p{L}]/u.test(label)||/[\x00-\x1f\x7f]/.test(label)))throw new Error('Tax-year folders need explicit, unique tax-year labels')}
 }}}
 if(!value.folders.some(r=>r.value==='Other'))throw new Error('Keep an Other category for documents without a match')
 languageProfile(value.languages);return JSON.parse(JSON.stringify(value)) as FilingRules
}
export function filingProfile(rules?:FilingRules){return rules?languageProfile([...defaultLanguageProfile.packs.filter(p=>!rules.languages.some(extra=>extra.id===p.id)),...rules.languages.map(pack=>({...pack,eras:pack.eras??defaultLanguageProfile.packs.find(base=>base.id===pack.id)?.eras}))]):defaultLanguageProfile}
export function ruleSupported(value:string,quotes:string[],rows:ClassificationRule[],rules:FilingRules){
 const row=rows.find(r=>r.value===value);if(!row)return false
 if(!row.terms.length)return categorySupported(value,quotes,filingProfile(rules))
 const normalizedQuotes=quotes.map(quote=>quote.normalize('NFKC').toLowerCase()),text=normalizedQuotes.join(' '),escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 return row.terms.some(term=>{const cue=term.normalize('NFKC').toLowerCase();return row.match==='substring'?(text.includes(cue)||layoutSubstringSupported(cue,normalizedQuotes)):new RegExp('(?<![\\p{L}\\p{N}\\p{M}])'+escape(cue)+'(?![\\p{L}\\p{N}\\p{M}])','u').test(text)})
}
export function renderFilingTemplate(template:string,values:Record<string,string>){return safePath(template.replace(/\{([^}]+)\}/g,(_,key)=>{const value=values[key];if(value===undefined)throw new Error('Missing filing template value');if(key!=='category'&&value.includes('/'))throw new Error('A filename fact contains a path separator');return value}))}

// Only an explicitly labelled Gregorian year may select a tax-year folder. A
// printed document date, an era year, or a range is not a substitute.
export function taxYearFromPages(pages:string[],labels:string[]):string{
 const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),years=new Set<string>();let invalid=false
 const patterns=labels.map(label=>new RegExp('(?<![\\p{L}\\p{N}\\p{M}])'+escape(label.normalize('NFKC'))+'(?:[ \\t]*[:=][ \\t]*|[ \\t]+)','giu'))
 for(const page of pages)for(const original of page.split(/\r?\n/)){
  const line=original.normalize('NFKC')
  for(const pattern of patterns){pattern.lastIndex=0;for(const match of line.matchAll(pattern)){
   const remainder=line.slice(match.index!+match[0].length),year=/^(\d{4})(?=$|[ \t,.;)\]年])/u.exec(remainder)
   if(!year||year[1]==='0000'){invalid=true;continue}
   const tail=remainder.slice(year[0].length)
   if(/^[ \t]*(?:[-/–—]|\d|(?:[.,;])[ \t]*\d|\b(?:and|or|to)\b)/i.test(tail)||/^[ \t]*年[ \t]*\d{1,2}[ \t]*月/u.test(tail)){invalid=true;continue}
   years.add(year[1]!)
  }}
 }
 if(invalid||years.size!==1)throw new Error(years.size>1?'Conflicting tax years need review. Choose the destination folder.':'An unambiguous labelled tax year is required. Choose the destination folder.')
 return [...years][0]!
}

export function explicitFolderMatches(pages:string[],rules:FilingRules){
 return rules.folders.filter(row=>row.value!=='Other'&&row.terms.length).flatMap(row=>{const evidence:{page:number;quote:string}[]=[];pages.forEach((page,index)=>page.split(/\r?\n/).forEach(line=>{if(line.length<=2000&&evidence.length<8&&ruleSupported(row.value,[line],[row],rules))evidence.push({page:index+1,quote:line})}));return evidence.length?[{value:row.value,evidence}]:[]})
}
