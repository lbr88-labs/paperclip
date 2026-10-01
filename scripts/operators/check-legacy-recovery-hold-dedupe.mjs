#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

let INSTANCE_DIR;
let CONFIG_PATH;
let EXPECTED_DATA_DIR;
let PG_MODULE_PATH;

function report(status, reason, details = {}) {
  console.log(JSON.stringify({ status, reason, ...details }));
  if (status !== 'healthy') process.exitCode = 1;
}

async function main() {
  try {
    const { values } = parseArgs({ options: {
      'instance-dir': { type: 'string' },
      config: { type: 'string' },
      'pg-module': { type: 'string' },
    }, allowPositionals: false });
    INSTANCE_DIR = path.resolve(values['instance-dir'] || process.env.PAPERCLIP_INSTANCE_DIR || path.join(homedir(), '.paperclip/instances/default'));
    CONFIG_PATH = path.resolve(values.config || process.env.PAPERCLIP_CONFIG || path.join(INSTANCE_DIR, 'config.json'));
    EXPECTED_DATA_DIR = path.join(INSTANCE_DIR, 'db');
    PG_MODULE_PATH = path.resolve(values['pg-module'] || process.env.PAPERCLIP_PG_MODULE || path.join(homedir(), '.paperclip/cli/current/node_modules/pg/esm/index.mjs'));
  } catch {
    report('unhealthy', 'invalid_arguments');
    return;
  }
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    report('unhealthy', 'config_unavailable');
    return;
  }
  const database = config?.database;
  if (database?.mode !== 'embedded-postgres' ||
      database.embeddedPostgresDataDir !== EXPECTED_DATA_DIR ||
      (database.connectionString != null && database.connectionString !== '') ||
      !Number.isInteger(database.embeddedPostgresPort) ||
      database.embeddedPostgresPort < 1 || database.embeddedPostgresPort > 65535) {
    report('unhealthy', 'config_target_mismatch');
    return;
  }
  // Paperclip's runtime target can be overridden even when config.json says embedded.
  if (process.env.DATABASE_URL?.trim()) {
    report('unhealthy', 'database_override');
    return;
  }
  try {
    const instanceEnv = await readFile(path.join(INSTANCE_DIR, '.env'), 'utf8');
    const override = instanceEnv.split(/\r?\n/).some((line) => {
      const match = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/);
      if (!match) return false;
      const value = match[1].trim().replace(/\s+#.*$/, '').trim();
      return value !== '' && value !== '""' && value !== "''";
    });
    if (override) {
      report('unhealthy', 'database_override');
      return;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      report('unhealthy', 'instance_env_unavailable');
      return;
    }
  }

  let client;
  try {
    const [pidText, ownerDir, , portText] =
      (await readFile(path.join(EXPECTED_DATA_DIR, 'postmaster.pid'), 'utf8')).split('\n');
    const ownerPid = Number(pidText);
    const actualPort = Number(portText);
    if (!Number.isSafeInteger(ownerPid) || ownerPid < 1 ||
        !Number.isSafeInteger(actualPort) || actualPort < 1 || actualPort > 65535 ||
        actualPort !== database.embeddedPostgresPort ||
        !ownerDir || await realpath(ownerDir) !== await realpath(EXPECTED_DATA_DIR)) {
      report('unhealthy', 'database_owner_mismatch');
      return;
    }
    try {
      process.kill(ownerPid, 0);
    } catch {
      report('unhealthy', 'database_owner_mismatch');
      return;
    }
    const pg = await import(pathToFileURL(PG_MODULE_PATH).href);
    const Client = pg.Client || pg.default?.Client;
    client = new Client({
      host: '127.0.0.1',
      port: actualPort,
      user: 'paperclip',
      password: 'paperclip',
      database: 'paperclip',
      connectionTimeoutMillis: 3000,
      query_timeout: 4000,
      options: '-c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000',
    });
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const { rows: [{ data_directory: dataDir }] } = await client.query('SHOW data_directory');
    if (await realpath(dataDir) !== await realpath(EXPECTED_DATA_DIR)) {
      report('unhealthy', 'database_target_mismatch');
      return;
    }

    const { rows: [catalog] } = await client.query(`
      WITH routine_function AS (
        SELECT p.oid
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'paperclip_dedupe_legacy_recovery_holds'
          AND p.oid = to_regprocedure('public.paperclip_dedupe_legacy_recovery_holds(uuid)')
          AND p.prorettype = 'integer'::regtype
          AND p.prokind = 'f'
      )
      SELECT EXISTS (SELECT 1 FROM routine_function) AS function_exists,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_trigger t
               WHERE t.tgname = 'paperclip_dedupe_legacy_recovery_holds_on_resolve'
                 AND t.tgrelid = 'public.issue_recovery_actions'::regclass
                 AND t.tgfoid = to_regprocedure('public.paperclip_dedupe_legacy_recovery_holds_trigger()')
                 AND t.tgenabled IN ('O', 'A')
                 AND NOT t.tgisinternal
             ) AS trigger_enabled
    `);

    const { rows: [{ residual_duplicate_holds: residualDuplicateHolds }] } = await client.query(`
      SELECT count(*)::integer AS residual_duplicate_holds
      FROM public.issue_recovery_actions older
      WHERE older.kind = 'active_run_watchdog'
        AND older.cause = 'legacy_execution_requires_reconciliation'
        AND older.status = 'resolved'
        AND older.outcome = 'blocked'
        AND older.evidence #>> '{automaticRecovery,replay}' = 'blocked'
        AND NOT (older.evidence ? 'executionReconciliation')
        AND NOT (older.evidence ? 'continuationDelivery')
        AND NOT (older.evidence ? 'supersededNoReplayHold')
        AND EXISTS (
          SELECT 1 FROM public.issue_recovery_actions canonical
          WHERE canonical.company_id = older.company_id
            AND canonical.source_issue_id = older.source_issue_id
            AND canonical.kind = older.kind
            AND canonical.cause = older.cause
            AND canonical.fingerprint = older.fingerprint
            AND canonical.fingerprint = 'legacy-execution:' || (canonical.evidence ->> 'runId')
            AND canonical.created_at > older.created_at
            AND canonical.status = 'resolved'
            AND canonical.evidence #>> '{executionReconciliation,providerStopped}' = 'true'
            AND canonical.evidence #>> '{executionReconciliation,actionOutcome}'
                IN ('completed', 'not_performed', 'mixed')
            AND canonical.evidence ->> 'continuationDelivery' = 'pending'
            AND canonical.evidence #>> '{executionReconciliation,runId}' = older.evidence ->> 'runId'
            AND canonical.evidence ->> 'runId' = older.evidence ->> 'runId'
            AND older.evidence #>> '{automaticRecovery,runId}' = canonical.evidence ->> 'runId'
        )
    `);
    if (!catalog.function_exists || !catalog.trigger_enabled || residualDuplicateHolds !== 0) {
      report('unhealthy', 'trigger_or_duplicate_holds', {
        functionExists: catalog.function_exists,
        triggerEnabled: catalog.trigger_enabled,
        residualDuplicateHolds,
      });
      return;
    }
    report('healthy', 'ok', { residualDuplicateHolds });
  } catch {
    report('unhealthy', 'check_failed');
  } finally {
    if (client) {
      try { await client.end(); } catch { /* Connection may already be closed. */ }
    }
  }
}

await main();
