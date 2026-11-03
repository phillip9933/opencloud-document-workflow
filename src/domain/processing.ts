// SPDX-License-Identifier: AGPL-3.0-only
export interface ProcessingProgress {step:number;total:number;label:string;attention?:boolean;cancelled?:boolean}
export interface ProcessingIssueInfo {queueId?:string;message:string;nextStep:string;settings?:string;retryable:boolean}
export interface ProcessingItem {state?:string|null;intakeState?:string|null;reviewState?:string|null;decision?:string|null;proposalState?:string|null;stage?:string|null;automatic?:{state:string}|null;progress?:ProcessingProgress}
// Five workflow milestones, not a percentage or an estimate of elapsed time.
export function processingProgress(item:ProcessingItem):ProcessingProgress {
 const state=item.intakeState??item.state??'unprocessed',decision=item.decision??item.reviewState,automatic=item.automatic?.state
 const progress=(step:number,label:string,extra:Partial<ProcessingProgress>={})=>({step,total:5,label,...extra})
 if(['duplicate','restored'].includes(state))return progress(2,'Duplicate held')
 if(state==='trashed'||state==='removed')return progress(5,'In OpenCloud Trash')
 if(decision==='done')return progress(5,'Filed')
 if(automatic==='done'||state==='processed')return progress(5,'Processed')
 if(decision&&['approved','folders_pending','move_done','transfer_ready'].includes(decision))return progress(4,'Filing',item.state==='cancelled'||automatic==='held'?{attention:true}:{})
 if(decision&&['move_intent','tags_intent','copy_intent','conflict'].includes(decision))return progress(4,'Verify filing outcome',{attention:true})
 const stage=item.stage==='review'?4:['analysing','tagging'].includes(item.stage??'')?3:item.stage==='reading'||item.stage==='ocr'?2:1
 if(state==='cancelled'||automatic==='cancelled')return progress(stage,'Cancelled',{cancelled:true})
 if(state==='superseded')return progress(1,'Replaced by a newer upload')
 if(decision==='rejected')return progress(5,'File kept in place')
 if(['settling','queued'].includes(state))return progress(1,state==='settling'?'Waiting for upload':'Waiting to prepare')
 if(state==='running'||state==='failed')return progress(item.stage?stage:2,item.stage==='tagging'?'Reviewing tags with AI':item.stage==='analysing'?'Analysing with AI':item.stage==='ocr'?'Reading scanned pages':'Reading PDF text',state==='failed'?{attention:true}:{})
 if(item.proposalState==='needs_ocr'||decision==='needs_ocr')return progress(2,'Needs text extraction',{attention:true})
 if(item.proposalState==='needs_details'||decision==='needs_details')return progress(4,'Choose filing details')
 if(state==='prepared'||decision==='needs_review'||automatic==='held')return progress(4,'Ready to review',automatic==='held'?{attention:true}:{})
 return progress(1,state==='settling'?'Waiting for upload':state==='queued'?'Waiting to prepare':'Discovered')
}

export function processingStatus(item:ProcessingItem):string {
 const progress=item.progress??processingProgress(item),state=item.intakeState??item.state,decision=item.decision??item.reviewState
 if(progress.attention)return 'Needs attention'
 if(progress.cancelled)return 'Cancelled'
 if(['duplicate','restored','trashed'].includes(state??''))return 'Duplicates'
 if(state==='removed')return 'In OpenCloud Trash'
 if(decision==='rejected')return 'Suggestion rejected'
 if(progress.step===5)return 'Completed'
 if(state==='running')return 'Processing'
 if(['settling','queued'].includes(state??''))return 'Waiting'
 if(decision==='rejected')return 'Suggestion rejected'
 if(item.proposalState==='needs_details'||decision==='needs_details')return 'Manual review'
 if(progress.step===4)return 'Ready to review'
 return 'Discovered'
}
export function processingKind(kind:string):string{return({prepare:'Document preparation',file:'Filing',metadata:'Field and tag updates',automatic:'Automatic filing',convert:'PDF conversion'} as Record<string,string>)[kind]??kind}
export function processingRecordStatus(state:string):string{return({done:'Completed',completed:'Completed',needs_review:'Ready to review',needs_details:'Manual review',needs_ocr:'Needs text extraction',failed:'Needs attention',held:'Needs attention',queued:'Waiting',pending:'Waiting',running:'Processing',cancelled:'Cancelled',paused:'Paused',approved:'Approved',rejected:'Suggestion rejected'} as Record<string,string>)[state]??state.replaceAll('_',' ')}
