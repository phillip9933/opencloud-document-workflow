import {samples} from '../../src/domain/samples'
import {validateBundle} from '../../src/domain/review'
import {filingProfile,defaultFilingRules} from '../../src/domain/filing'
import {printedDateISO,defaultLanguageProfile} from '../../src/domain/languages'
it('restores the exact quoted name span when PDF layout inserts spaces without changing letters',()=>{
 const bundle=structuredClone(samples()[0]!),claim=bundle.proposal!.issuer,old=claim.value,printed=Array.from(old).join(' ')
 bundle.pages=bundle.pages.map(page=>page.replaceAll(old,printed));claim.evidence=claim.evidence.map(e=>({...e,quote:e.quote.replaceAll(old,printed)}))
 const result=validateBundle(bundle);expect(result.bundle.proposal!.issuer.value).toBe(printed);expect(validateBundle(result.bundle).state).toBe('needs_review')
 claim.value='Unprinted company';expect(()=>validateBundle(bundle)).toThrow('Fact is not present')
})
it('adds built-in era rules to saved language packs without replacing custom dates or explicit era choices',()=>{
 const rules=defaultFilingRules(),ja=structuredClone(defaultLanguageProfile.packs.find(p=>p.id==='ja')!);rules.languages.push(ja);delete ja.eras
 expect(printedDateISO('令和7年9月18日',filingProfile(rules))).toBe('2025-09-18')
 ja.eras=[];expect(()=>printedDateISO('令和7年9月18日',filingProfile(rules))).toThrow('Unsupported')
})
it('prepares a synthetic Japanese registration with spaced printed name and era date without inventing facts',()=>{
 const bundle=structuredClone(samples()[0]!);bundle.pages=['株式会社       サンプル\n令 和     7年    9 月 18 日\n自動車検査証記録事項'];bundle.proposal={issuer:{value:'株式会社 サンプル',evidence:[{page:1,quote:'株式会社       サンプル'}]},date:{value:'令和7年9月18日',evidence:[{page:1,quote:'令 和     7年    9 月 18 日'}]},kind:{value:'自動車検査証記録事項',evidence:[{page:1,quote:'自動車検査証記録事項'}]},folder:{value:'Other',evidence:[{page:1,quote:'自動車検査証記録事項'}]},tags:[]}
 const result=validateBundle(bundle);expect(result.state).toBe('needs_review');expect(result.proposal!.issuer.value).toBe('株式会社       サンプル');expect(result.proposal!.date.value).toBe('令 和     7年    9 月 18 日');expect(printedDateISO(result.proposal!.date.value)).toBe('2025-09-18');expect(validateBundle(result.bundle).state).toBe('needs_review')
 bundle.proposal.date.value='令和8年9月18日';expect(()=>validateBundle(bundle)).toThrow('Fact is not present')
})

it('restores exact page quotes when only extraction whitespace differs, without accepting changed text',()=>{
 const bundle=structuredClone(samples()[0]!),issuer=bundle.proposal!.issuer;const printed='Example   Electricity Company';bundle.pages=bundle.pages.map(p=>p.replaceAll(issuer.value,printed));const result=validateBundle(bundle);expect(result.proposal!.issuer.value).toBe(printed);expect(result.proposal!.issuer.evidence[0]!.quote).toBe(printed);expect(validateBundle(result.bundle).state).toBe('needs_review');issuer.evidence[0]!.quote='Example Electric Company';expect(()=>validateBundle(bundle)).toThrow('Quote is absent')
})
it('holds ambiguous whitespace-only quotes and changed digits instead of choosing a source span',()=>{
 const bundle=structuredClone(samples()[0]!);bundle.pages[0]+='\nExample Electricity   Company';bundle.proposal!.issuer.evidence[0]!.quote='Example  Electricity Company';expect(()=>validateBundle(bundle)).toThrow('Quote is absent');bundle.proposal!.issuer.evidence[0]!.quote=bundle.proposal!.issuer.value;bundle.proposal!.date.evidence[0]!.quote='2026-10-28';expect(()=>validateBundle(bundle)).toThrow('Quote is absent')
})
it('interprets layout spacing between printed date words without changing the source date or merging digit fields',()=>{
 const bundle=structuredClone(samples()[0]!);bundle.pages[0]=bundle.pages[0]!.replaceAll(bundle.proposal!.date.value,'29   October   2026');bundle.proposal!.date={value:'29 October 2026',evidence:[{page:1,quote:'29 October 2026'}]};const result=validateBundle(bundle);expect(result.proposal!.date.value).toBe('29   October   2026');expect(printedDateISO(result.proposal!.date.value)).toBe('2026-10-29');expect(()=>printedDateISO('29October2026')).toThrow('Unsupported');expect(()=>printedDateISO('29 October 26')).toThrow('Unsupported');expect(()=>printedDateISO('01/02/2026')).toThrow('Ambiguous')
})
it.each([0,2])('recovers out-of-range citation %s only from its one actual source page',page=>{
 const bundle=structuredClone(samples()[0]!);bundle.proposal!.issuer.evidence[0]!.page=page;const result=validateBundle(bundle);expect(result.proposal!.issuer.evidence[0]!.page).toBe(1);expect(result.bundle.source).toEqual(bundle.source);expect(result.bundle.pages).toEqual(bundle.pages);expect(validateBundle(result.bundle).state).toBe('needs_review');bundle.proposal!.issuer.value='Unprinted company';expect(()=>validateBundle(bundle)).toThrow('Fact is not present')
})
it('holds an invalid page when the quote is absent or appears on more than one page',()=>{
 const bundle=structuredClone(samples()[0]!);bundle.proposal!.issuer.evidence[0]!.page=0;bundle.pages.push(bundle.pages[0]!);expect(()=>validateBundle(bundle)).toThrow('Invalid evidence page');bundle.pages.splice(1);bundle.proposal!.issuer.evidence[0]!.quote='Unprinted quotation';expect(()=>validateBundle(bundle)).toThrow('Invalid evidence page')
})
it('restores actual full-width names, punctuation and dates instead of accepting normalized text as a quote',()=>{
 const bundle=structuredClone(samples()[0]!),issuer='Ｅｘａｍｐｌｅ　Ｅｌｅｃｔｒｉｃｉｔｙ　Ｃｏｍｐａｎｙ',date='２０２６－１０－２９';bundle.pages[0]=bundle.pages[0]!.replaceAll(bundle.proposal!.issuer.value,issuer).replaceAll(bundle.proposal!.date.value,date);const result=validateBundle(bundle);expect(result.proposal!.issuer.value).toBe(issuer);expect(result.proposal!.issuer.evidence[0]!.quote).toBe(issuer);expect(result.proposal!.date.value).toBe(date);expect(result.proposal!.date.evidence[0]!.quote).toBe(date);expect(printedDateISO(result.proposal!.date.value)).toBe('2026-10-29');expect(validateBundle(result.bundle).state).toBe('needs_review');bundle.proposal!.date.value='2025-10-29';expect(()=>validateBundle(bundle)).toThrow('Fact is not present')
})
it('holds ambiguous presentation matches and cannot cite just part of an expanded Unicode glyph',()=>{
 const bundle=structuredClone(samples()[0]!);bundle.pages[0]+='\nＥｘａｍｐｌｅ　Ｅｌｅｃｔｒｉｃｉｔｙ　Ｃｏｍｐａｎｙ';bundle.proposal!.issuer.evidence[0]!.quote='Example  Electricity Company';expect(()=>validateBundle(bundle)).toThrow('Quote is absent');bundle.proposal!.issuer.evidence[0]!.quote=bundle.proposal!.issuer.value;bundle.pages[0]+='\nﬁ';bundle.proposal!.kind={value:'i',evidence:[{page:1,quote:'ﬁ'}]};expect(()=>validateBundle(bundle)).toThrow('Fact is not present')
})
it('restores a complete printed era date when the model returns its equivalent Gregorian date, including labelled quotes',()=>{
 const bundle=structuredClone(samples()[0]!),printed='令 和 7年 9月 18日';bundle.pages[0]=bundle.pages[0]!.replaceAll(bundle.proposal!.date.value,'記録年月日 '+printed);bundle.proposal!.date={value:'2025-09-18',evidence:[{page:1,quote:'記録年月日 '+printed}]};const result=validateBundle(bundle);expect(result.proposal!.date.value).toBe(printed);expect(result.proposal!.date.evidence[0]!.quote).toBe('記録年月日 '+printed);expect(validateBundle(result.bundle).state).toBe('needs_review');bundle.proposal!.date.value='2025-09-19';expect(()=>validateBundle(bundle)).toThrow('Fact is not present')
})
it('restores the exact named-month date and never invents a day, century or ambiguous date convention',()=>{
 const bundle=structuredClone(samples()[0]!);bundle.pages[0]=bundle.pages[0]!.replaceAll(bundle.proposal!.date.value,'Issued: 29   October   2026');bundle.proposal!.date={value:'2026-10-29',evidence:[{page:1,quote:'Issued: 29   October   2026'}]};expect(validateBundle(bundle).proposal!.date.value).toBe('29   October   2026')
 for(const printed of ['Tax year: 2026','01/02/2026','29 October 26','2026-02-30']){const b=structuredClone(samples()[0]!);b.pages[0]='Example Electricity Company\nElectricity Invoice\n'+printed;b.proposal!.date={value:printed.startsWith('01/')?'2026-01-02':'2026-10-29',evidence:[{page:1,quote:printed}]};expect(()=>validateBundle(b)).toThrow('Fact is not present')}
})

it('restores unique case and wrapped heading spans while keeping filenames on one line',async()=>{
 const{filename,actions,defaultPolicy}=await import('../../src/domain/review'),bundle=structuredClone(samples()[0]!),heading='Example Certified Professional 6\nData Center Virtualization';bundle.pages[0]+='\n'+heading;bundle.proposal!.issuer={value:'EXAMPLE ELECTRICITY COMPANY',evidence:[{page:1,quote:'example electricity company'}]};bundle.proposal!.kind={value:'example certified professional 6 data center virtualization',evidence:[{page:1,quote:'EXAMPLE CERTIFIED PROFESSIONAL 6 DATA CENTER VIRTUALIZATION'}]};const review=validateBundle(bundle);expect(review.proposal!.issuer.value).toBe('Example Electricity Company');expect(review.proposal!.kind.value).toBe(heading);expect(review.proposal!.kind.evidence[0]!.quote).toBe(heading);expect(validateBundle(review.bundle).proposal!.kind.value).toBe(heading);expect(filename(review.proposal!)).toContain('Example Certified Professional 6 Data Center Virtualization.pdf');expect(actions(review,defaultPolicy())!.target).not.toMatch(/[\r\n\t]/);
 const{defaultFilingRules}=await import('../../src/domain/filing'),configured=validateBundle({...review.bundle,rules:defaultFilingRules()});expect(actions(configured,defaultPolicy())!.target).not.toMatch(/[\r\n\t]/);bundle.proposal!.kind.value='Unprinted certificate';expect(()=>validateBundle(bundle)).toThrow('Fact is not present')
})
it('holds ambiguous case-only quotations and non-whitespace control characters',()=>{
 const bundle=structuredClone(samples()[0]!);bundle.pages[0]+='\nEXAMPLE ELECTRICITY COMPANY';bundle.proposal!.issuer.evidence[0]!.quote='example electricity company';expect(()=>validateBundle(bundle)).toThrow('Quote is absent');bundle.proposal!.issuer.evidence[0]!.quote='Example Electricity Company';bundle.proposal!.issuer.value='Example\u0000Electricity Company';expect(()=>validateBundle(bundle)).toThrow('Invalid text field')
})
