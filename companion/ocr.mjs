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
export async function ocrPages(bytes,pages,languages,limits=defaultLimits()){
 limits=validateLimits(limits)
 if(!Array.isArray(languages)||!languages.length||languages.length>10||languages.some(v=>typeof v!=='string'||!/^[A-Za-z0-9_/-]+$/.test(v)||v.includes('..')))throw new Error('Choose OCR languages')
 const installed=await ocrLanguages();if(languages.some(l=>!installed.includes(l)))throw new Error('Selected OCR language data is not installed')
 const dir=await mkdtemp(join(tmpdir(),'workflow-ocr-'))
 try{await writeFile(join(dir,'input.pdf'),bytes,{mode:0o600});const result=[...pages],start=Date.now()
  for(let i=0;i<pages.length;i++){if(pages[i].trim())continue;if(Date.now()-start>Math.max(240000,pages.length*60000))throw new Error('OCR document time limit reached')
   const prefix=join(dir,'page');await runOCRTool('pdftoppm',['-f',String(i+1),'-l',String(i+1),'-r','150','-scale-to','2200','-singlefile','-gray','-png',join(dir,'input.pdf'),prefix])
   if((await stat(prefix+'.png')).size>16*1024*1024)throw new Error('OCR raster exceeds limit')
   result[i]=await runOCRTool('tesseract',[prefix+'.png','stdout','-l',languages.join('+'),'--psm','3'],{timeout:45000});await rm(prefix+'.png')
   if(result.reduce((n,p)=>n+p.length,0)>limits.maxCharacters)throw new Error('OCR text exceeds limit')
  }return result
 }finally{await rm(dir,{recursive:true,force:true})}
}
