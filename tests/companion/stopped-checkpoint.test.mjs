// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,chmod,rm,readFile,writeFile,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {ProposalJournal} from '../../companion/journal.mjs'
import {Workflow} from '../../companion/workflow.mjs'
import {Metadata} from '../../companion/metadata.mjs'
import {DocumentLibrary} from '../../companion/documents.mjs'
import {Intake} from '../../companion/intake.mjs'
import {stoppedCheckpoint} from '../../companion/stopped-checkpoint.mjs'
import {verifySnapshot} from '../../companion/backups.mjs'
test('stopped WAL-mode journals checkpoint from read-only source storage without changing original bytes or records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-stopped-')),source=join(root,'state'),directory=join(root,'backups'),database=join(source,'workflow.sqlite3');await mkdir(source,{mode:0o700});const journal=new ProposalJournal(database),w=new Workflow(journal);new Metadata(w);new DocumentLibrary(w);new Intake(w);journal.db.prepare('insert into saved_views values(?,?,?,?)').run('synthetic','keep','Synthetic marker','{}');journal.close();const before=await readFile(database);await chmod(source,0o500)
 try{const result=await stoppedCheckpoint(database,directory);assert.equal(result.state,'verified');assert.deepEqual(await readFile(database),before);const verified=await verifySnapshot(result.directory),copy=new DatabaseSync(verified.file,{readOnly:true});try{assert.equal(copy.prepare('select name from saved_views where scope=?').get('synthetic').name,'Synthetic marker')}finally{copy.close()}}
 finally{await chmod(source,0o700);await rm(root,{recursive:true})}
})
test('missing journals are fresh; nonempty WALs, symlinks and non-private sources hold before snapshotting',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-stopped-hold-')),database=join(root,'workflow.sqlite3'),directory=join(root,'backups');try{assert.equal((await stoppedCheckpoint(database,directory)).state,'fresh');await writeFile(database,'synthetic source',{mode:0o600});await writeFile(database+'-wal','pending data');await assert.rejects(stoppedCheckpoint(database,directory),/pending journal/);assert.equal(await readFile(database,'utf8'),'synthetic source');await rm(database+'-wal');await chmod(database,0o644);await assert.rejects(stoppedCheckpoint(database,directory),/private stopped/);await chmod(database,0o600);const link=join(root,'link.sqlite3');await symlink(database,link);await assert.rejects(stoppedCheckpoint(link,directory),/private stopped/)}finally{await rm(root,{recursive:true})}
})
