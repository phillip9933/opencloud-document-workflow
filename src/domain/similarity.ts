// SPDX-License-Identifier: AGPL-3.0-only
import {dateSearchCandidates,printedDateISO} from './languages.ts'
import {filingProfile,type FilingRules} from './filing.ts'
export interface DocumentFingerprint {grams:Set<string>;identifiers:Set<string>;dates:Set<string>;amounts:Set<string>;length:number}
const currencyCodes=new Set(Intl.supportedValuesOf('currency').map(value=>value.toLowerCase()))
const overlap=(a:Set<string>,b:Set<string>)=>[...a].filter(value=>b.has(value)).length
export function documentIdentifiers(pages:string[]):Set<string>{
 const text=pages.join('\n').normalize('NFKC').toLowerCase();if(text.length>200000)return new Set()
 const identifiers=new Set<string>()
 for(const line of text.split('\n'))for(const value of line.replace(/\s/gu,'').match(/[a-z0-9]{10,40}/g)??[])if(/\d/.test(value)&&(/^[0-9]{10,24}$/.test(value)||/[a-z]/.test(value)))identifiers.add(value)
 return identifiers
}
export function documentFingerprint(pages:string[],rules?:FilingRules,includeGrams=true):DocumentFingerprint|null {
 const normalized=pages.join('\n').normalize('NFKC'),text=normalized.toLowerCase()
 if(text.length<200||text.length>200000)return null
 const profile=filingProfile(rules),dates=new Set<string>()
 for(const candidate of dateSearchCandidates(text,profile)){try{dates.add(printedDateISO(candidate,profile))}catch{/* Incomplete or ambiguous dates provide no duplicate evidence. */}}
 const identifiers=documentIdentifiers(pages)
 const amounts=new Set((text.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|(?:\p{Sc}\s*\d+(?:[,.]\d+)*|\d+(?:[,.]\d+)*\s*[円元圓원])/gu)??[]).map(value=>value.replace(/[\s,]/g,'')))
 // ISO currency codes are uppercase; ordinary words such as All are not amounts.
 for(const match of normalized.matchAll(/\b([A-Z]{3})\s*(\d+(?:[,.]\d+)*)\b|\b(\d+(?:[,.]\d+)*)\s*([A-Z]{3})\b/g)){const code=(match[1]??match[4]!).toLowerCase(),number=match[2]??match[3]!;if(currencyCodes.has(code))amounts.add(code+number.replace(/,/g,''))}
 const compact=text.replace(/[^\p{L}\p{N}]/gu,''),grams=new Set<string>()
 if(includeGrams)for(let i=0;i+5<=compact.length;i++)grams.add(compact.slice(i,i+5))
 return{grams,identifiers,dates,amounts,length:compact.length}
}
export function compareFingerprints(a:DocumentFingerprint|null,b:DocumentFingerprint|null){
 if(!a||!b||!a.grams.size||!b.grams.size)return{candidate:false,overlap:0,sharedIdentifiers:0,sharedDates:0}
 const shared=overlap(a.grams,b.grams),coverage=shared/Math.min(a.grams.size,b.grams.size),dice=2*shared/(a.grams.size+b.grams.size),sharedIdentifiers=overlap(a.identifiers,b.identifiers),sharedDates=overlap(a.dates,b.dates)
 // A potential duplicate is advisory only. Different recurring bills must not
 // qualify through their template, shared account or provider identifiers.
 const sameDates=sharedDates>0&&sharedDates===a.dates.size&&sharedDates===b.dates.size
 const partialDates=sharedDates>0&&(sharedDates===a.dates.size||sharedDates===b.dates.size)
 const amountsCompatible=a.amounts.size===b.amounts.size&&overlap(a.amounts,b.amounts)===a.amounts.size
 const strongPrintedIdentity=[...a.identifiers].some(value=>b.identifiers.has(value)&&value.length>=14&&/[a-z]/.test(value)&&/\d/.test(value))
 const textMatch=sharedIdentifiers>=2&&coverage>=.9&&dice>=.85
 const scanMatch=strongPrintedIdentity&&coverage>=.45&&dice>=.42
 return{candidate:amountsCompatible&&(sameDates&&textMatch||partialDates&&scanMatch),overlap:dice,coverage,sharedIdentifiers,sharedDates}
}
