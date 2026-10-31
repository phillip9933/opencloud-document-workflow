// SPDX-License-Identifier: AGPL-3.0-only
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import {defaultLimits,validateLimits} from './configuration.mjs'
import { validateDocumentInput } from '../src/domain/review.ts'
export async function extractPDF(path, source,limits=defaultLimits()) {
  limits=validateLimits(limits);const chunks=[];let total=0
  for await(const chunk of createReadStream(path)){total+=chunk.length;if(total>limits.maxMiB*1024*1024)throw new Error('PDF exceeds the configured processing size');chunks.push(chunk)}
  const data=Buffer.concat(chunks)
  return extractPDFBytes(data,source,limits)
}
export async function extractPDFBytes(data,source,limits=defaultLimits()) {
  limits=validateLimits(limits)
  if (data.length>limits.maxMiB*1024*1024 || !data.subarray(0,5).equals(Buffer.from('%PDF-'))) throw new Error('Expected a PDF within the configured processing size')
  // Feed exactly the bytes hashed, not a path that could change between reads.
  const { spawn } = await import('node:child_process')
  const text = await new Promise((resolve,reject)=> {
    const child=spawn('pdftotext',['-layout','-','-'],{stdio:['pipe','pipe','pipe']})
    const chunks=[]; let bytes=0, settled=false
    const finish=(error,result)=> { if(settled)return; settled=true;clearTimeout(timer);error?reject(error):resolve(result) }
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('PDF extraction timed out'))},30_000)
    child.on('error',()=>finish(new Error('Poppler pdftotext is required')))
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>limits.maxCharacters*4){child.kill('SIGKILL');finish(new Error('PDF extracted text exceeds limit'))}else chunks.push(chunk)})
    child.stderr.resume();child.stdin.on('error',()=>{})
    child.on('close',code=>code===0?finish(null,Buffer.concat(chunks).toString('utf8')):finish(new Error('PDF extraction failed')))
    child.stdin.end(data)
  })
  const pages=text.split('\f'); if(pages.length && !pages.at(-1).trim())pages.pop()
  if(pages.length>limits.maxPages||pages.reduce((n,p)=>n+p.length,0)>limits.maxCharacters)throw new Error('PDF exceeds configured page or text capacity; adjust Processing settings')
  return validateDocumentInput({schemaVersion:1,source:{...source,sha256:createHash('sha256').update(data).digest('hex')},pages})
}
