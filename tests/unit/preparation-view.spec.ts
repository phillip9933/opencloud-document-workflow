// SPDX-License-Identifier: AGPL-3.0-only
import{mount}from'@vue/test-utils'
import PreparationReview from '../../src/components/PreparationReview.vue'
import{samples}from'../../src/domain/samples'
import{inspectProposal}from'../../src/domain/review'
it('shows retained source-backed details and identifies an invalid date without displaying the rejected value',()=>{
 const bundle=samples()[0]!,{proposal,...input}=bundle,raw=structuredClone(proposal!);raw.date.value='2099-12-31'
 const view=mount(PreparationReview,{props:{report:inspectProposal(input,raw)}})
 try{expect(view.text()).toContain('Example Electricity Company');expect(view.text()).toContain('Date');expect(view.text()).toContain('does not match its quoted text');expect(view.text()).not.toContain('2099-12-31');expect(view.find('button').exists()).toBe(false)}finally{view.unmount()}
})
