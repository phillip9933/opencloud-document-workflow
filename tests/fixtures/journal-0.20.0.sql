-- Synthetic schema snapshot of the 0.20.0 journal before versioned migrations.
-- No document data or credentials. SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE activity(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,job TEXT,kind TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);

CREATE TABLE automatic_runs(job TEXT PRIMARY KEY,scope TEXT NOT NULL,authorization TEXT NOT NULL,state TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE bulk_items(operation TEXT NOT NULL,position INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(operation,position));

CREATE TABLE bulk_operations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE conversion_reformats(id TEXT PRIMARY KEY,scope TEXT NOT NULL,record TEXT NOT NULL);

CREATE TABLE conversion_settings(scope TEXT PRIMARY KEY,archive TEXT NOT NULL);

CREATE TABLE conversions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,record TEXT NOT NULL);

CREATE TABLE cross_transfers(job TEXT PRIMARY KEY,scope TEXT NOT NULL,source TEXT NOT NULL,target_space TEXT NOT NULL,target_path TEXT NOT NULL,resource TEXT,state TEXT NOT NULL,baseline TEXT,trash_ack INTEGER NOT NULL DEFAULT 0);

CREATE TABLE decisions(job TEXT PRIMARY KEY,actor TEXT NOT NULL,record TEXT NOT NULL,state TEXT NOT NULL,plan TEXT,updated TEXT NOT NULL);

CREATE TABLE document_trash(id TEXT PRIMARY KEY,scope TEXT NOT NULL,resource TEXT NOT NULL,source TEXT NOT NULL,sha TEXT NOT NULL,baseline TEXT NOT NULL,state TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0,trash_id TEXT,created TEXT NOT NULL);

CREATE TABLE duplicate_settings(scope TEXT PRIMARY KEY,folder TEXT NOT NULL,action TEXT NOT NULL);

CREATE TABLE duplicate_trash(queue_id TEXT PRIMARY KEY,scope TEXT NOT NULL,source TEXT NOT NULL,keeper TEXT NOT NULL,sha TEXT NOT NULL,baseline TEXT NOT NULL,state TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0,trash_id TEXT,created TEXT NOT NULL);

CREATE TABLE file_locations(scope TEXT NOT NULL,resource TEXT NOT NULL,space TEXT NOT NULL,target_resource TEXT NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,job TEXT NOT NULL,PRIMARY KEY(scope,resource));

CREATE TABLE filed_locations(scope TEXT NOT NULL,space TEXT NOT NULL,root TEXT NOT NULL,resource TEXT NOT NULL,path TEXT NOT NULL,tags TEXT NOT NULL,etag TEXT NOT NULL,PRIMARY KEY(scope,space,root,resource));

CREATE TABLE filing_locations(scope TEXT PRIMARY KEY,space TEXT NOT NULL);

CREATE TABLE intake_content(scope TEXT NOT NULL,sha TEXT NOT NULL,resource TEXT NOT NULL,job TEXT,PRIMARY KEY(scope,sha));

CREATE TABLE intake_control(scope TEXT PRIMARY KEY,paused INTEGER NOT NULL DEFAULT 0);

CREATE TABLE intake_health(scope TEXT PRIMARY KEY,last_attempt INTEGER,last_success INTEGER,reason TEXT,message TEXT);

CREATE TABLE intake_queue(id TEXT PRIMARY KEY,scope TEXT NOT NULL,resource TEXT NOT NULL,path TEXT NOT NULL,etag TEXT NOT NULL,first_seen INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,job TEXT,detail TEXT, last_seen TEXT, stage TEXT, issue TEXT);

CREATE TABLE intake_settings(scope TEXT PRIMARY KEY,value TEXT NOT NULL,last_scan INTEGER NOT NULL DEFAULT 0);

CREATE TABLE metadata(scope TEXT NOT NULL,resource TEXT NOT NULL,version INTEGER NOT NULL,fields TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(scope,resource));

CREATE TABLE metadata_changes(id TEXT PRIMARY KEY,scope TEXT NOT NULL,resource TEXT NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,etag TEXT NOT NULL,base INTEGER NOT NULL,fields TEXT NOT NULL,tags TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL);

CREATE TABLE metadata_schema(scope TEXT PRIMARY KEY,value TEXT NOT NULL);

CREATE TABLE metadata_tag_removals(change_id TEXT PRIMARY KEY,tag TEXT NOT NULL);

CREATE TABLE ocr_settings(scope TEXT PRIMARY KEY,languages TEXT NOT NULL);

CREATE TABLE preferences(scope TEXT PRIMARY KEY,configuration TEXT NOT NULL);

CREATE TABLE preparation_attempts(scope TEXT NOT NULL,space TEXT NOT NULL,resource TEXT NOT NULL,etag TEXT NOT NULL,state TEXT NOT NULL,stage TEXT NOT NULL,job TEXT,issue TEXT,started TEXT NOT NULL,updated TEXT NOT NULL,owner TEXT NOT NULL,PRIMARY KEY(scope,space,resource));

CREATE TABLE processing_settings(scope TEXT PRIMARY KEY,rules TEXT NOT NULL,limits TEXT NOT NULL);

CREATE TABLE proposals (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, input TEXT NOT NULL, configuration TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, pid INTEGER, host TEXT,
        result TEXT, raw TEXT, error TEXT, updated TEXT NOT NULL
      );

CREATE TABLE resource_aliases(scope TEXT NOT NULL,resource TEXT NOT NULL,space TEXT NOT NULL,canonical TEXT NOT NULL,PRIMARY KEY(scope,resource));

CREATE TABLE saved_views(scope TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,query TEXT NOT NULL,PRIMARY KEY(scope,id));

CREATE TABLE workflow_locks(job TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL);

CREATE TABLE workspace_selection(server TEXT NOT NULL,account TEXT NOT NULL,space TEXT NOT NULL,PRIMARY KEY(server,account));

CREATE INDEX bulk_item_source ON bulk_items(json_extract(input,'$.resourceId'),state,operation);

CREATE INDEX decisions_updated ON decisions(updated,job);

CREATE INDEX document_trash_resource ON document_trash(scope,resource,state);

CREATE INDEX intake_scope ON intake_queue(scope,state);

CREATE INDEX metadata_changes_lookup ON metadata_changes(scope,resource,state,created,id);

CREATE INDEX proposals_resource_latest ON proposals(scope,json_extract(input,'$.source.resourceId'),updated DESC,id DESC);

CREATE INDEX proposals_scope_updated ON proposals(scope,updated,id);

CREATE TRIGGER activity_no_delete BEFORE DELETE ON activity BEGIN SELECT RAISE(ABORT,'Activity is append-only'); END;

CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity BEGIN SELECT RAISE(ABORT,'Activity is append-only'); END;
