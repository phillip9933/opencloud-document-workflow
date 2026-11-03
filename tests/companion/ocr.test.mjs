// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {ocrLanguages,ocrPages,ocrCandidatePages} from '../../companion/ocr.mjs'
import {extractPDFBytes} from '../../companion/extract.mjs'
import {samples} from '../../src/domain/samples.ts'
test('local OCR discovers languages, reads a raster PDF, and preserves original bytes and nonblank pages',async()=>{
 assert.ok((await ocrLanguages()).includes('eng'));const bytes=readFileSync(new URL('../fixtures/scanned-english.pdf',import.meta.url)),hash=createHash('sha256').update(bytes).digest('hex'),input=await extractPDFBytes(bytes,samples()[0].source);assert.equal(input.pages[0].trim(),'');const result=await ocrPages(bytes,input.pages,['eng']);assert.match(result[0],/Invoice number: TEST-42/);assert.match(result[0],/2026-10-29/);assert.match(result[0],/Example Electricity Company/);assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);const unchanged=await ocrPages(bytes,['Retained scanner text'],['eng']);assert.deepEqual(unchanged,['Retained scanner text'])
})
test('uninstalled languages and argument injection are held before document processing',async()=>{await assert.rejects(ocrPages(Buffer.from(''),[''],['missing_test_language']),/not installed/);await assert.rejects(ocrPages(Buffer.from(''),[''],['eng --config']),/Choose OCR/);await assert.rejects(ocrPages(Buffer.from(''),[''],[]),/Choose OCR/)})

test('reads a large scanned page behind sparse embedded text and keeps both sources',async()=>{
 const bytes=readFileSync(new URL('../fixtures/hybrid-english.pdf',import.meta.url)),input=await extractPDFBytes(bytes,samples()[0].source),hash=createHash('sha256').update(bytes).digest('hex');assert.match(input.pages[0],/Embedded reference: SYNTH-17/);assert.doesNotMatch(input.pages[0],/Electricity Company/);const indices=await ocrCandidatePages(bytes,input.pages);assert.deepEqual(indices,[0]);const result=await ocrPages(bytes,input.pages,['eng'],undefined,{indices});assert.match(result[0],/Embedded reference: SYNTH-17/);assert.match(result[0],/Example Electricity Company/);assert.equal(createHash('sha256').update(bytes).digest('hex'),hash)
 const textOnly=readFileSync(new URL('../fixtures/english.pdf',import.meta.url));assert.deepEqual(await ocrCandidatePages(textOnly,['Short embedded text']),[]);assert.deepEqual(await ocrCandidatePages(Buffer.from('not read because no sparse page'),['A long embedded text page. '.repeat(20)]),[]);await assert.rejects(ocrPages(bytes,input.pages,['eng'],undefined,{indices:[-1]}),/page selection/)
})

test('recovers photographed receipts when global thresholding yields no readable text',async()=>{
 const bytes=readFileSync(new URL('../fixtures/photographed-receipt.pdf',import.meta.url)),hash=createHash('sha256').update(bytes).digest('hex'),input=await extractPDFBytes(bytes,samples()[0].source),result=await ocrPages(bytes,input.pages,['eng']);assert.match(result[0],/Example Receipt Company/);assert.match(result[0],/TEST-42/);assert.match(result[0],/2026-10-29/);assert.equal(createHash('sha256').update(bytes).digest('hex'),hash)
})
