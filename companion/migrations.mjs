// SPDX-License-Identifier: AGPL-3.0-only
import { withTransaction } from './transactions.mjs'
import { DatabaseSync } from 'node:sqlite'

export const JOURNAL_SCHEMA_VERSION = 1

// Baseline of the released, unversioned journal. Never edit an applied migration;
// append a numbered migration instead. Demo fixture tables are intentionally separate.
const baseline = String.raw`
CREATE TABLE IF NOT EXISTS activity(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,job TEXT,kind TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS automatic_runs(job TEXT PRIMARY KEY,scope TEXT NOT NULL,authorization TEXT NOT NULL,state TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bulk_items(operation TEXT NOT NULL,position INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(operation,position));

CREATE TABLE IF NOT EXISTS bulk_operations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS conversion_reformats(id TEXT PRIMARY KEY,scope TEXT NOT NULL,record TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS conversion_settings(scope TEXT PRIMARY KEY,archive TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS conversions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,record TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS cross_transfers(job TEXT PRIMARY KEY,scope TEXT NOT NULL,source TEXT NOT NULL,target_space TEXT NOT NULL,target_path TEXT NOT NULL,resource TEXT,state TEXT NOT NULL,baseline TEXT,trash_ack INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS decisions(job TEXT PRIMARY KEY,actor TEXT NOT NULL,record TEXT NOT NULL,state TEXT NOT NULL,plan TEXT,updated TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS document_trash(id TEXT PRIMARY KEY,scope TEXT NOT NULL,resource TEXT NOT NULL,source TEXT NOT NULL,sha TEXT NOT NULL,baseline TEXT NOT NULL,state TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0,trash_id TEXT,created TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS duplicate_settings(scope TEXT PRIMARY KEY,folder TEXT NOT NULL,action TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS duplicate_trash(queue_id TEXT PRIMARY KEY,scope TEXT NOT NULL,source TEXT NOT NULL,keeper TEXT NOT NULL,sha TEXT NOT NULL,baseline TEXT NOT NULL,state TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0,trash_id TEXT,created TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS file_locations(scope TEXT NOT NULL,resource TEXT NOT NULL,space TEXT NOT NULL,target_resource TEXT NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,job TEXT NOT NULL,PRIMARY KEY(scope,resource));

CREATE TABLE IF NOT EXISTS filed_locations(scope TEXT NOT NULL,space TEXT NOT NULL,root TEXT NOT NULL,resource TEXT NOT NULL,path TEXT NOT NULL,tags TEXT NOT NULL,etag TEXT NOT NULL,PRIMARY KEY(scope,space,root,resource));

CREATE TABLE IF NOT EXISTS filing_locations(scope TEXT PRIMARY KEY,space TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS intake_content(scope TEXT NOT NULL,sha TEXT NOT NULL,resource TEXT NOT NULL,job TEXT,PRIMARY KEY(scope,sha));

CREATE TABLE IF NOT EXISTS intake_control(scope TEXT PRIMARY KEY,paused INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS intake_health(scope TEXT PRIMARY KEY,last_attempt INTEGER,last_success INTEGER,reason TEXT,message TEXT);

CREATE TABLE IF NOT EXISTS intake_queue(id TEXT PRIMARY KEY,scope TEXT NOT NULL,resource TEXT NOT NULL,path TEXT NOT NULL,etag TEXT NOT NULL,first_seen INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,job TEXT,detail TEXT, last_seen TEXT, stage TEXT, issue TEXT);

CREATE TABLE IF NOT EXISTS intake_settings(scope TEXT PRIMARY KEY,value TEXT NOT NULL,last_scan INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS metadata(scope TEXT NOT NULL,resource TEXT NOT NULL,version INTEGER NOT NULL,fields TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(scope,resource));

CREATE TABLE IF NOT EXISTS metadata_changes(id TEXT PRIMARY KEY,scope TEXT NOT NULL,resource TEXT NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,etag TEXT NOT NULL,base INTEGER NOT NULL,fields TEXT NOT NULL,tags TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS metadata_schema(scope TEXT PRIMARY KEY,value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS metadata_tag_removals(change_id TEXT PRIMARY KEY,tag TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS ocr_settings(scope TEXT PRIMARY KEY,languages TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS preferences(scope TEXT PRIMARY KEY,configuration TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS preparation_attempts(scope TEXT NOT NULL,space TEXT NOT NULL,resource TEXT NOT NULL,etag TEXT NOT NULL,state TEXT NOT NULL,stage TEXT NOT NULL,job TEXT,issue TEXT,started TEXT NOT NULL,updated TEXT NOT NULL,owner TEXT NOT NULL,PRIMARY KEY(scope,space,resource));

CREATE TABLE IF NOT EXISTS processing_settings(scope TEXT PRIMARY KEY,rules TEXT NOT NULL,limits TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, input TEXT NOT NULL, configuration TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, pid INTEGER, host TEXT,
        result TEXT, raw TEXT, error TEXT, updated TEXT NOT NULL
      );

CREATE TABLE IF NOT EXISTS resource_aliases(scope TEXT NOT NULL,resource TEXT NOT NULL,space TEXT NOT NULL,canonical TEXT NOT NULL,PRIMARY KEY(scope,resource));

CREATE TABLE IF NOT EXISTS saved_views(scope TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,query TEXT NOT NULL,PRIMARY KEY(scope,id));

CREATE TABLE IF NOT EXISTS workflow_locks(job TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS workspace_selection(server TEXT NOT NULL,account TEXT NOT NULL,space TEXT NOT NULL,PRIMARY KEY(server,account));

CREATE INDEX IF NOT EXISTS bulk_item_source ON bulk_items(json_extract(input,'$.resourceId'),state,operation);

CREATE INDEX IF NOT EXISTS decisions_updated ON decisions(updated,job);

CREATE INDEX IF NOT EXISTS document_trash_resource ON document_trash(scope,resource,state);

CREATE INDEX IF NOT EXISTS intake_scope ON intake_queue(scope,state);

CREATE INDEX IF NOT EXISTS metadata_changes_lookup ON metadata_changes(scope,resource,state,created,id);

CREATE INDEX IF NOT EXISTS proposals_resource_latest ON proposals(scope,json_extract(input,'$.source.resourceId'),updated DESC,id DESC);

CREATE INDEX IF NOT EXISTS proposals_scope_updated ON proposals(scope,updated,id);

CREATE TRIGGER IF NOT EXISTS activity_no_delete BEFORE DELETE ON activity BEGIN SELECT RAISE(ABORT,'Activity is append-only'); END;

CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity BEGIN SELECT RAISE(ABORT,'Activity is append-only'); END;`

/** @param {DatabaseSync} db */
function upgradeLegacyColumns(db) {
  for (const [table, columns] of Object.entries({
    proposals: ['raw'],
    intake_queue: ['last_seen', 'stage', 'issue']
  })) {
    const existing = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
    )
    for (const column of columns) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
    }
  }
}

/** @param {DatabaseSync} db */
function schemaShape(db) {
  const objects = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    .all()
  return objects.map((object) => ({
    type: object.type,
    name: object.name,
    table: object.tbl_name,
    columns:
      object.type === 'table'
        ? db
            .prepare('SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info(?)')
            .all(object.name)
            .map(({ name, type, notnull, dflt_value, pk }) => ({
              name,
              type,
              notnull,
              dflt_value,
              pk
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        : null,
    sql: object.type === 'table' ? null : String(object.sql).replace(/\s+/g, ' ').trim()
  }))
}

/** @type {ReturnType<typeof schemaShape> | undefined} */
let expectedShape
function expectedSchema() {
  if (!expectedShape) {
    const scratch = new DatabaseSync(':memory:')
    try {
      scratch.exec(baseline)
      expectedShape = schemaShape(scratch)
    } finally {
      scratch.close()
    }
  }
  return expectedShape
}

/** @param {DatabaseSync} db */
export function verifyJournalSchema(db) {
  const expected = expectedSchema()
  const actual = new Map(schemaShape(db).map((object) => [object.name, object]))
  for (const object of expected) {
    if (JSON.stringify(actual.get(object.name)) !== JSON.stringify(object)) {
      throw Object.assign(
        new Error(
          'Unsupported journal schema; restore compatible code or inspect the database offline'
        ),
        { code: 'SCHEMA_MISMATCH' }
      )
    }
  }
}

/** @param {DatabaseSync} db */
export function migrateJournal(db) {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  if (!Number.isInteger(version) || version < 0 || version > JOURNAL_SCHEMA_VERSION) {
    throw Object.assign(
      new Error(
        'Journal was created by an unsupported schema version; use compatible companion code'
      ),
      { code: 'SCHEMA_VERSION' }
    )
  }
  if (version === JOURNAL_SCHEMA_VERSION) {
    verifyJournalSchema(db)
    return
  }
  withTransaction(db, () => {
    db.exec(baseline)
    upgradeLegacyColumns(db)
    verifyJournalSchema(db)
    db.exec('PRAGMA user_version=1')
  })
}
