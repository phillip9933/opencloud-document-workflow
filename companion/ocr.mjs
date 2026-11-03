// SPDX-License-Identifier: AGPL-3.0-only
import {defaultLimits,validateLimits} from './configuration.mjs'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
export function runOCRTool(command,args,{limit=240000,timeout=30000}={}){return new Promise((resolve,reject)=>{
 const child=spawn(command,args,{stdio:['ignore','pipe','pipe']}),chunks=[];let total=0,done=false
 const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result)}
 const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('OCR command timed out'))},timeout)
 child.on('error',()=>finish(new Error(`OCR requires ${command}`)));child.stderr.resume();child.stdout.on('data',c=>{total+=c.length;if(total>limit){child.kill('SIGKILL');finish(new Error('OCR output exceeds limit'))}else chunks.push(c)});child.on('close',code=>code===0?finish(null,Buffer.concat(chunks).toString('utf8')):finish(new Error('OCR command failed')))
})}
export async function ocrLanguages(){const text=await runOCRTool('tesseract',['--list-langs']);return text.split(/\r?\n/).slice(1).map(v=>v.trim()).filter(v=>/^[A-Za-z0-9_/-]+$/.test(v)&&v!=='osd')}
// Short embedded text can be a watermark or variable certificate fields over
// a scanned page. Read large page images too, without OCRing short text PDFs.
export async function ocrCandidatePages(bytes,pages){
 const blank=pages.flatMap((page,index)=>!page.trim()?[index]:[]),sparse=pages.flatMap((page,index)=>page.trim()&&page.replace(/\s/gu,'').length<200?[index]:[])
 if(!sparse.length)return blank
 const dir=await mkdtemp(join(tmpdir(),'workflow-ocr-detect-'))
 try{
  const path=join(dir,'input.pdf');await writeFile(path,bytes,{mode:0o600})
  const sizes=await runOCRTool('pdfinfo',['-f','1','-l',String(pages.length),path]),images=await runOCRTool('pdfimages',['-list',path]),areas=new Map()
  for(const line of sizes.split(/\r?\n/)){const match=/^Page\s+(\d+)\s+size:\s+([0-9.]+) x ([0-9.]+) pts/.exec(line);if(match)areas.set(Number(match[1])-1,Number(match[2])*Number(match[3]))}
  const selected=new Set(blank)
  for(const line of images.split(/\r?\n/)){const fields=line.trim().split(/\s+/);if(fields[2]!=='image')continue;const index=Number(fields[0])-1,width=Number(fields[3]),height=Number(fields[4]),xppi=Number(fields[12]),yppi=Number(fields[13]),area=areas.get(index);if(sparse.includes(index)&&area>0&&xppi>0&&yppi>0&&width*height*72*72/(xppi*yppi)>=area*.45)selected.add(index)}
  return [...selected].sort((a,b)=>a-b)
 }finally{await rm(dir,{recursive:true,force:true})}
}
export async function ocrPages(bytes,pages,languages,limits=defaultLimits(),{indices=pages.flatMap((page,index)=>!page.trim()?[index]:[])}={}){
 limits=validateLimits(limits)
 if(!Array.isArray(indices)||indices.some(index=>!Number.isInteger(index)||index<0||index>=pages.length)||new Set(indices).size!==indices.length)throw new Error('Invalid OCR page selection')
 if(!Array.isArray(languages)||!languages.length||languages.length>10||languages.some(v=>typeof v!=='string'||!/^[A-Za-z0-9_/-]+$/.test(v)||v.includes('..')))throw new Error('Choose OCR languages')
 const installed=await ocrLanguages();if(languages.some(l=>!installed.includes(l)))throw new Error('Selected OCR language data is not installed')
 const dir=await mkdtemp(join(tmpdir(),'workflow-ocr-'))
 try{await writeFile(join(dir,'input.pdf'),bytes,{mode:0o600});const result=[...pages],start=Date.now()
  for(let i=0;i<pages.length;i++){if(!indices.includes(i))continue;if(Date.now()-start>Math.max(240000,pages.length*90000))throw new Error('OCR document time limit reached')
   const prefix=join(dir,'page');await runOCRTool('pdftoppm',['-f',String(i+1),'-l',String(i+1),'-r','300','-scale-to','3500','-singlefile','-gray','-png',join(dir,'input.pdf'),prefix])
   if((await stat(prefix+'.png')).size>16*1024*1024)throw new Error('OCR raster exceeds limit')
   let recognized=await runOCRTool('tesseract',[prefix+'.png','stdout','-l',languages.join('+'),'--psm','3'],{timeout:45000});
   // Dark receipt photos on a white sheet can become solid blocks under global
   // thresholding. Retry empty output once with Tesseract's local threshold.
   if(!recognized.trim())recognized=await runOCRTool('tesseract',[prefix+'.png','stdout','-l',languages.join('+'),'--psm','3','-c','thresholding_method=2'],{timeout:45000});result[i]=pages[i].trim()?pages[i]+'\n'+recognized:recognized;await rm(prefix+'.png')
   if(result.reduce((n,p)=>n+p.length,0)>limits.maxCharacters)throw new Error('OCR text exceeds limit')
  }return result
 }finally{await rm(dir,{recursive:true,force:true})}
}
