// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {extractPDF} from '../../companion/extract.mjs'
import {samples} from '../../src/domain/samples.ts'
for(const [name,quote] of [['english','Example Electricity Company'],['japanese','飯山市上下水道事業'],['image-only','']]){
 test(`extracts exact ${name} PDF bytes without rewriting`,async()=>{
  const path=new URL(`../fixtures/${name}.pdf`,import.meta.url)
  const before=readFileSync(path),input=await extractPDF(path,samples()[0].source)
  assert.equal(input.source.sha256,createHash('sha256').update(before).digest('hex'))
  assert.ok(input.pages[0].includes(quote))
  if(!quote)assert.equal(input.pages[0].trim(),'')
  assert.deepEqual(readFileSync(path),before)
 })
}
