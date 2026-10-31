// SPDX-License-Identifier: AGPL-3.0-only
// For the installer's already-stopped journal. The source mount remains read-only.
import {lstat,realpath,mkdir,copyFile,rm} from 'node:fs/promises'
import {createReadStream,constants} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {resolve,join} from 'node:path'
import {BackupManager} from './backups.mjs'
async function hash(path){const h=createHash('sha256');for await(const bytes of createReadStream(path,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}))h.update(bytes);return h.digest('hex')}
async function noPendingJournal(database){for(const suffix of ['-wal','-journal']){try{const s=await lstat(database+suffix);if(!s.isFile()||s.isSymbolicLink()||s.size)throw Error('Stop the worker cleanly before checkpointing; pending journal data is retained')}catch(e){if(e.code!=='ENOENT')throw e}}}
export async function stoppedCheckpoint(database,directory){
 database=resolve(database);directory=resolve(directory)
 let info;try{info=await lstat(database)}catch(e){if(e.code==='ENOENT')return{state:'fresh'};throw e}
 if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||await realpath(database)!==database||info.size<=0||info.size>8*1024**3)throw Error('Invalid private stopped journal')
 await noPendingJournal(database)
 await mkdir(directory,{recursive:true,mode:0o700});const destination=await lstat(directory)
 if(!destination.isDirectory()||destination.isSymbolicLink()||(destination.mode&0o077)||await realpath(directory)!==directory)throw Error('Private checkpoint storage required')
 // SQLite's WAL header may require writable auxiliary files even when there is
 // no pending WAL. Verify/copy the stopped bytes, then use SQLite on that private
 // disposable copy instead of weakening the source mount or opening it writable.
 const before=await hash(database),stage=join(directory,'.checkpoint-source-'+randomUUID())
 await mkdir(stage,{mode:0o700});const copy=join(stage,'database.sqlite3')
 await copyFile(database,copy,constants.COPYFILE_EXCL)
 await noPendingJournal(database)
 if(await hash(database)!==before||await hash(copy)!==before)throw Error('Stopped journal changed during checkpoint; the private copy is retained')
 const manager=new BackupManager({database:copy,directory,maxSnapshots:1000,maxBytes:8*1024**3}),snapshot=await manager.tick({force:true})
 if(!snapshot)throw Error('Pre-upgrade checkpoint held: '+manager.status().reason)
 await rm(stage,{recursive:true})
 return{state:'verified',directory:snapshot.directory,sha256:snapshot.sha256,sourceSHA256:before}
}
