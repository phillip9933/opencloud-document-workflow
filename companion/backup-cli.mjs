// SPDX-License-Identifier: AGPL-3.0-only
import {BackupManager,verifySnapshot,restoreSnapshot} from './backups.mjs'
const [operation,...args]=process.argv.slice(2)
try{
 if(operation==='create'&&args.length===2){const manager=new BackupManager({database:args[0],directory:args[1]}),result=await manager.tick({force:true});if(!result)throw new Error('Backup held: '+manager.status().reason);console.log(JSON.stringify({state:'verified',directory:result.directory,sha256:result.sha256,bytes:result.bytes}))}
 else if(operation==='verify'&&args.length===1){const result=await verifySnapshot(args[0]);console.log(JSON.stringify({state:'verified',sha256:result.sha256,bytes:result.bytes}))}
 else if(operation==='restore'&&args.length===2)console.log(JSON.stringify(await restoreSnapshot(args[0],args[1])))
 else throw new Error('Usage: backup-cli.mjs create DATABASE BACKUP_DIRECTORY | verify SNAPSHOT_DIRECTORY | restore SNAPSHOT_DIRECTORY NEW_DATABASE')
}catch(e){console.error(e.backupReason??(e.message.startsWith('Usage:')?e.message:'Backup/recovery held; inspect private configuration and local evidence.'));process.exitCode=1}
