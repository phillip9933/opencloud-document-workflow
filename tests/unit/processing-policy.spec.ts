// SPDX-License-Identifier: AGPL-3.0-only
import {editableProcessingPolicy,processingPolicy,processingMode,modeProcessingPolicy} from '../../src/domain/processing-policy'
import type {Policy} from '../../src/domain/review'
const automatic:Policy={ocr:'automatic',aiInput:'automatic',aiOutput:'automatic',fields:'automatic',rename:'automatic',move:'automatic',tags:'automatic'}
it('projects legacy AI or OCR review gates conservatively instead of enabling unattended changes when saved',()=>{
 for(const held of [{...automatic,aiInput:'suggest' as const},{...automatic,aiOutput:'suggest' as const},{...automatic,ocr:'suggest' as const}]){const draft=editableProcessingPolicy(held),saved=processingPolicy(draft);for(const key of ['fields','rename','move','tags'] as const)expect(saved[key]).toBe('suggest');expect(saved.aiInput).toBe('suggest');expect(saved.aiOutput).toBe('suggest');expect(held.rename).toBe('automatic')}
})
it('keeps explicit automatic choices automatic, disabled analysis disabled, and review choices behind review gates',()=>{
 expect(processingPolicy(editableProcessingPolicy(automatic))).toEqual(automatic)
 expect(processingPolicy({...automatic,aiInput:'off'})).toMatchObject({aiInput:'off',aiOutput:'off'})
 expect(processingPolicy({...automatic,move:'suggest'})).toMatchObject({aiInput:'suggest',aiOutput:'suggest',move:'suggest',tags:'automatic'})
})

it('keeps every review-mode write behind acceptance even when other suggestions are off',()=>{
 const off={...automatic,fields:'off',rename:'off',move:'off',tags:'off'} as Policy
 expect(modeProcessingPolicy(off,'review')).toMatchObject({...off,aiInput:'suggest',aiOutput:'suggest'})
 expect(processingMode({...automatic,move:'off'})).toBe('review')
 expect(modeProcessingPolicy({...automatic,move:'off'},'review')).toMatchObject({rename:'suggest',move:'off',aiInput:'suggest'})
 expect(modeProcessingPolicy(off,'automatic')).toEqual(automatic)
})
