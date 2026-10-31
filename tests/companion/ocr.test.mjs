// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {ocrLanguages,ocrPages} from '../../companion/ocr.mjs'
import {extractPDFBytes} from '../../companion/extract.mjs'
import {samples} from '../../src/domain/samples.ts'
test('local OCR discovers languages, reads a raster PDF, and preserves original bytes and nonblank pages',async()=>{
 assert.ok((await ocrLanguages()).includes('eng'));const bytes=readFileSync(new URL('../fixtures/scanned-english.pdf',import.meta.url)),hash=createHash('sha256').update(bytes).digest('hex'),input=await extractPDFBytes(bytes,samples()[0].source);assert.equal(input.pages[0].trim(),'');const result=await ocrPages(bytes,input.pages,['eng']);assert.match(result[0],/Invoice number: TEST-42/);assert.match(result[0],/2026-10-29/);assert.match(result[0],/Example Electricity Company/);assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);const unchanged=await ocrPages(bytes,['Retained scanner text'],['eng']);assert.deepEqual(unchanged,['Retained scanner text'])
})
test('uninstalled languages and argument injection are held before document processing',async()=>{await assert.rejects(ocrPages(Buffer.from(''),[''],['missing_test_language']),/not installed/);await assert.rejects(ocrPages(Buffer.from(''),[''],['eng --config']),/Choose OCR/);await assert.rejects(ocrPages(Buffer.from(''),[''],[]),/Choose OCR/)})
