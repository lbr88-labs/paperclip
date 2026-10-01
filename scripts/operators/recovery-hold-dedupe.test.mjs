import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

// Run after workspace dependencies are installed. No existing database is used.
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const embeddedPath = require.resolve('embedded-postgres');
const { default: EmbeddedPostgres } = await import(pathToFileURL(embeddedPath).href);
const pgPath = createRequire(embeddedPath).resolve('pg');

const schema = `
CREATE TABLE issues (id uuid PRIMARY KEY, company_id uuid NOT NULL, identifier text,
 status text NOT NULL, hidden_at timestamptz, assignee_agent_id uuid, assignee_user_id text,
 execution_run_id uuid, checkout_run_id uuid, conversation_agent_id uuid, conversation_user_id text,
 responsible_user_id text, created_by_user_id text);
CREATE TABLE heartbeat_runs (id uuid PRIMARY KEY, company_id uuid NOT NULL, agent_id uuid NOT NULL,
 status text NOT NULL, finished_at timestamptz, scheduled_retry_at timestamptz,
 runtime_mode text NOT NULL, native_issue_id uuid, context_snapshot jsonb,
 retry_of_run_id uuid, responsible_user_id text);
CREATE TABLE issue_recovery_actions (id uuid PRIMARY KEY, company_id uuid NOT NULL,
 source_issue_id uuid NOT NULL REFERENCES issues(id), status text NOT NULL, cause text NOT NULL,
 kind text NOT NULL, owner_type text NOT NULL, owner_agent_id uuid, owner_user_id text,
 return_owner_agent_id uuid, outcome text, resolved_at timestamptz, wake_policy jsonb,
 monitor_policy jsonb, evidence jsonb NOT NULL DEFAULT '{}', fingerprint text NOT NULL,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX active_recovery ON issue_recovery_actions(company_id,source_issue_id)
 WHERE status IN ('active','escalated');
CREATE TABLE native_run_finalizations (run_id uuid PRIMARY KEY REFERENCES heartbeat_runs(id),
 company_id uuid NOT NULL, phase text NOT NULL, lease_owner text, result_id uuid, failure_detail jsonb);
CREATE TABLE environment_leases (id uuid PRIMARY KEY, company_id uuid NOT NULL,
 heartbeat_run_id uuid REFERENCES heartbeat_runs(id), released_at timestamptz);
CREATE TABLE activity_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
 actor_type text NOT NULL, actor_id text NOT NULL, action text NOT NULL, entity_type text NOT NULL,
 entity_id text NOT NULL, run_id uuid REFERENCES heartbeat_runs(id), responsible_user_id text, details jsonb);
`;
const company = '10000000-0000-0000-0000-000000000001';
const otherCompany = '10000000-0000-0000-0000-000000000002';
const issue = '20000000-0000-0000-0000-000000000001';
const agent = '30000000-0000-0000-0000-000000000001';
const run = '40000000-0000-0000-0000-000000000001';
const canonical = '50000000-0000-0000-0000-000000000001';
const hold = '50000000-0000-0000-0000-000000000002';
const second = '50000000-0000-0000-0000-000000000003';
const evidence = { runId: run, continuationDelivery: 'pending', executionReconciliation: {
 runId: run, providerStopped: true, actionOutcome: 'completed', outcomeEvidence: 'Confirmed that the provider stopped without pending work.' } };
const blocked = { runId: run, automaticRecovery: { runId: run, policy: 'preserve_without_replay_v1', replay: 'blocked' } };

test('operator SQL and read-only health checks against isolated embedded Postgres', { timeout: 120000 }, async (t) => {
 const root = await mkdtemp(path.join(process.env.TMPDIR || '/var/tmp', 'recovery-operator-test.'));
 const server = createServer();
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const port = server.address().port;
 await new Promise(resolve => server.close(resolve));
 const instance = path.join(root, 'instance');
 await mkdir(instance);
 const database = new EmbeddedPostgres({ databaseDir: path.join(instance, 'db'), port,
 user: 'paperclip', password: 'paperclip', persistent: false, onLog() {}, onError() {} });
 let client;
 try {
  await database.initialise(); await database.start(); await database.createDatabase('paperclip');
  client = database.getPgClient('paperclip'); await client.connect(); await client.query(schema);
  const sql = await readFile(new URL('./install-legacy-recovery-hold-dedupe.sql', import.meta.url), 'utf8');
  await client.query(sql); await client.query(sql); // Installation itself must be repeatable.
  async function seed() {
   await client.query('TRUNCATE activity_log, environment_leases, native_run_finalizations, issue_recovery_actions, heartbeat_runs, issues CASCADE');
   await client.query(`INSERT INTO issues(id,company_id,identifier,status,assignee_agent_id,created_by_user_id) VALUES($1,$2,'TEST-1','todo',$3,'operator')`, [issue,company,agent]);
   await client.query(`INSERT INTO heartbeat_runs(id,company_id,agent_id,status,finished_at,runtime_mode,native_issue_id) VALUES($1,$2,$3,'failed',now(),'legacy',$4)`, [run,company,agent,issue]);
   await client.query(`INSERT INTO issue_recovery_actions(id,company_id,source_issue_id,status,cause,kind,owner_type,return_owner_agent_id,outcome,resolved_at,evidence,fingerprint,created_at)
    VALUES($1,$2,$3,'active','legacy_execution_requires_reconciliation','active_run_watchdog','board',$4,'handed_back',now(),$5,$6,now())`,[canonical,company,issue,agent,evidence,`legacy-execution:${run}`]);
   await client.query(`INSERT INTO issue_recovery_actions SELECT $1,id_company,source_issue_id,'resolved',cause,kind,owner_type,owner_agent_id,owner_user_id,return_owner_agent_id,'blocked',now()-interval '2 hours',wake_policy,monitor_policy,$2,fingerprint,now()-interval '3 hours',now() FROM (SELECT *,company_id AS id_company FROM issue_recovery_actions WHERE id=$3) a`, [hold,blocked,canonical]);
  }
  async function resolve() { await client.query("UPDATE issue_recovery_actions SET status='resolved' WHERE id=$1",[canonical]); }
  async function holdUnchanged() {
   const {rows:[row]} = await client.query('SELECT evidence FROM issue_recovery_actions WHERE id=$1',[hold]);
   assert.deepEqual(row.evidence,blocked);
   assert.equal((await client.query('SELECT count(*)::int AS count FROM activity_log')).rows[0].count,0);
  }
  await t.test('valid hold is archived once and audited without modifying the canonical action', async () => {
   await seed(); await resolve();
   const {rows:[row]} = await client.query('SELECT evidence FROM issue_recovery_actions WHERE id=$1',[hold]);
   assert.equal(row.evidence.automaticRecovery.replay,undefined);
   assert.deepEqual(row.evidence.supersededNoReplayHold.automaticRecovery,blocked.automaticRecovery);
   assert.equal(row.evidence.supersededNoReplayHold.canonicalActionId,canonical);
   assert.equal((await client.query('SELECT evidence FROM issue_recovery_actions WHERE id=$1',[canonical])).rows[0].evidence.continuationDelivery,'pending');
   assert.equal((await client.query('SELECT paperclip_dedupe_legacy_recovery_holds($1) AS count',[canonical])).rows[0].count,0);
   const logs=(await client.query('SELECT * FROM activity_log')).rows;
   assert.equal(logs.length,1); assert.equal(logs[0].company_id,company); assert.equal(logs[0].run_id,run);
  });
  const rejects = [
   ['cross-tenant canonical',`UPDATE issue_recovery_actions SET company_id='${otherCompany}' WHERE id='${canonical}'`],
   ['cross-tenant older hold',`UPDATE issue_recovery_actions SET company_id='${otherCompany}' WHERE id='${hold}'`],
   ['cross-tenant run',`UPDATE heartbeat_runs SET company_id='${otherCompany}'`],
   ['running provider',`UPDATE heartbeat_runs SET status='running',finished_at=NULL`],
   ['scheduled retry',`UPDATE heartbeat_runs SET scheduled_retry_at=now()`],
   ['native provider',`UPDATE heartbeat_runs SET runtime_mode='native'`],
   ['different agent',`UPDATE heartbeat_runs SET agent_id='30000000-0000-0000-0000-000000000002'`],
   ['wrong run issue',`UPDATE heartbeat_runs SET native_issue_id='20000000-0000-0000-0000-000000000002'`],
   ['invalid UUID',`UPDATE issue_recovery_actions SET evidence=jsonb_set(evidence,'{runId}','"invalid"') WHERE id='${canonical}'`],
   ['insufficient reconciliation',`UPDATE issue_recovery_actions SET evidence=jsonb_set(evidence,'{executionReconciliation,outcomeEvidence}','"short"') WHERE id='${canonical}'`],
   ['leased environment',`INSERT INTO environment_leases VALUES(gen_random_uuid(),'${company}','${run}',NULL)`],
   ['active finalization',`INSERT INTO native_run_finalizations VALUES('${run}','${company}','terminal_failure','owner',NULL,NULL)`],
   ['successor run',`INSERT INTO heartbeat_runs SELECT gen_random_uuid(),company_id,agent_id,'failed',now(),NULL,'legacy',native_issue_id,NULL,id,NULL FROM heartbeat_runs`],
   ['ambiguous older hold',`UPDATE issue_recovery_actions SET fingerprint='different' WHERE id='${hold}'`],
   ['future older hold',`UPDATE issue_recovery_actions SET created_at=now()+interval '1 day' WHERE id='${hold}'`],
   ['pending second hold',`INSERT INTO issue_recovery_actions SELECT '${second}',company_id,source_issue_id,status,cause,kind,owner_type,owner_agent_id,owner_user_id,return_owner_agent_id,outcome,resolved_at,wake_policy,monitor_policy,'{"continuationDelivery":"pending"}',fingerprint,created_at,updated_at FROM issue_recovery_actions WHERE id='${hold}'`],
   ['checked-out issue',`UPDATE issues SET checkout_run_id='${run}'`],
   ['conversation issue',`UPDATE issues SET conversation_agent_id='${agent}',conversation_user_id='operator'`],
  ];
  for (const [name,mutation] of rejects) await t.test(name, async()=>{await seed();await client.query(mutation);await resolve();
   // Some cases intentionally mutate the original hold; absence of an archival marker is the invariant.
   assert.equal((await client.query("SELECT evidence ? 'supersededNoReplayHold' AS changed FROM issue_recovery_actions WHERE id=$1",[hold])).rows[0].changed,false);
   assert.equal((await client.query('SELECT count(*)::int AS count FROM activity_log')).rows[0].count,0);
  });
  await t.test('trigger failure rolls back dedupe writes while allowing resolution', async()=>{
   await seed(); await client.query("ALTER TABLE activity_log ADD CONSTRAINT reject_audit CHECK (action <> 'issue.execution_recovery_hold_superseded')");
   try {await resolve(); await holdUnchanged(); assert.equal((await client.query('SELECT status FROM issue_recovery_actions WHERE id=$1',[canonical])).rows[0].status,'resolved');}
   finally {await client.query('ALTER TABLE activity_log DROP CONSTRAINT reject_audit');}
  });
  await seed();await resolve();
  const configPath=path.join(instance,'config.json');
  const config={database:{mode:'embedded-postgres',embeddedPostgresDataDir:path.join(instance,'db'),embeddedPostgresPort:port}};
  await writeFile(configPath,JSON.stringify(config));
  function health(args=[],env={}) {
   const result=spawnSync(process.execPath,[new URL('./check-legacy-recovery-hold-dedupe.mjs',import.meta.url).pathname,'--instance-dir',instance,'--pg-module',pgPath,...args],{encoding:'utf8',env:{...process.env,DATABASE_URL:'',...env},timeout:15000});
   assert.equal(result.error,undefined);return {exit:result.status,...JSON.parse(result.stdout)};
  }
  await t.test('healthy instance is read only',async()=>{const before=(await client.query('SELECT count(*)::int AS count FROM activity_log')).rows[0].count;assert.equal(health().status,'healthy');assert.equal((await client.query('SELECT count(*)::int AS count FROM activity_log')).rows[0].count,before);});
  await t.test('reject runtime DATABASE_URL',()=>assert.equal(health([],{DATABASE_URL:'postgres://untrusted'}).reason,'database_override'));
  await t.test('reject instance dotenv DATABASE_URL',async()=>{await writeFile(path.join(instance,'.env'),'export DATABASE_URL="postgres://other"\n');assert.equal(health().reason,'database_override');await rm(path.join(instance,'.env'));});
  await t.test('reject unexpected configured port',async()=>{await writeFile(configPath,JSON.stringify({...config,database:{...config.database,embeddedPostgresPort:port+1}}));assert.equal(health().reason,'database_owner_mismatch');await writeFile(configPath,JSON.stringify(config));});
  await t.test('residual duplicate hold is unhealthy',async()=>{await seed();await client.query('ALTER TABLE issue_recovery_actions DISABLE TRIGGER paperclip_dedupe_legacy_recovery_holds_on_resolve');await resolve();await client.query('ALTER TABLE issue_recovery_actions ENABLE TRIGGER paperclip_dedupe_legacy_recovery_holds_on_resolve');const result=health();assert.equal(result.reason,'trigger_or_duplicate_holds');assert.equal(result.residualDuplicateHolds,1);await client.query('SELECT paperclip_dedupe_legacy_recovery_holds($1)',[canonical]);});
  await t.test('disabled trigger is unhealthy',async()=>{await client.query('ALTER TABLE issue_recovery_actions DISABLE TRIGGER paperclip_dedupe_legacy_recovery_holds_on_resolve');assert.equal(health().reason,'trigger_or_duplicate_holds');await client.query('ALTER TABLE issue_recovery_actions ENABLE TRIGGER paperclip_dedupe_legacy_recovery_holds_on_resolve');});
  await t.test('unknown arguments fail closed',()=>assert.equal(health(['--unexpected']).reason,'invalid_arguments'));
 } finally {if(client) await client.end(); await database.stop(); await rm(root,{recursive:true,force:true});}
});
