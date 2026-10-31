// SPDX-License-Identifier: AGPL-3.0-only
import {readFile} from 'node:fs/promises'
const release=JSON.parse(await readFile('/distribution/release.json','utf8'))
const origin=new URL(process.argv[2]??'http://127.0.0.1:5175').origin
const response=await fetch(origin+'/_workflow/api/healthz',{redirect:'error',signal:AbortSignal.timeout(10000)})
const value=await response.json()
if(!response.ok||value.service!=='document-workflow'||value.version!==release.version||value.apiVersion!==1||value.ready!==true)throw Error('Matching Document Workflow companion is not reachable')
if(process.argv[2]){const protectedResponse=await fetch(origin+'/_workflow/api/status',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(10000)});if(protectedResponse.status!==401)throw Error('The companion API must require OpenCloud sign-in')}
console.log('Matching companion '+release.version+' is ready')
