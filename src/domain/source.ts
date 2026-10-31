// SPDX-License-Identifier: AGPL-3.0-only
export async function pdfHash(blob:Blob):Promise<string>{
 const bytes=await blob.arrayBuffer()
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('')
}
