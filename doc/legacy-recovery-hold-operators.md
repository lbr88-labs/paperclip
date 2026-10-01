# Legacy recovery hold operator tools

These tools preserve an explicitly installed recovery customization. They are
operator scripts, not database migrations, and are never applied by server startup.
The SQL is the captured installation source, preserved without changes.

`install-legacy-recovery-hold-dedupe.sql` installs a `SECURITY INVOKER` function and
an after-update trigger in `public`. When a board-owned legacy execution recovery
is resolved with confirmed provider-stop evidence and a pending hand-back, it
archives older matching resolved no-replay holds and writes an activity log entry
for each. It never runs or retries a provider, marks an issue done, or removes the
canonical pending continuation. Ambiguous ownership, active runs, retries,
finalization work, environment leases, or conflicting holds cause it to do nothing.

## Installation and removal

Inspect the target database, outstanding recovery work, and backup before choosing
to install this customization. Use the appropriate authenticated PostgreSQL
connection for the chosen installation; do not infer a target from another
instance's configuration. The database must have the current Paperclip recovery,
run, finalization, lease, issue, and activity-log tables. The installing role needs
permission to create functions and the trigger; invocation uses the caller's table
permissions. The script wraps installation in a transaction and is repeatable.

```sh
psql "$OPERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f scripts/operators/install-legacy-recovery-hold-dedupe.sql
```

Installation does not backfill old resolutions. To inspect a single already
resolved canonical action, an operator can first use a rollback transaction:

```sql
BEGIN;
SELECT public.paperclip_dedupe_legacy_recovery_holds('<canonical-action-uuid>');
-- Inspect affected evidence and activity_log entries in this transaction.
ROLLBACK;
```

The function returns the number of archived holds, or zero if any guard rejects
the action. Future qualifying resolutions invoke it automatically. A trigger
failure rolls back its own archive and audit writes, logs a PostgreSQL warning,
and allows the original resolution to complete. Monitor warnings and health
results; successful issue resolution alone does not prove successful deduplication.

To uninstall, remove the trigger first. Existing evidence archives and activity
logs remain available:

```sql
BEGIN;
DROP TRIGGER IF EXISTS paperclip_dedupe_legacy_recovery_holds_on_resolve
  ON public.issue_recovery_actions;
DROP FUNCTION IF EXISTS public.paperclip_dedupe_legacy_recovery_holds_trigger();
DROP FUNCTION IF EXISTS public.paperclip_dedupe_legacy_recovery_holds(uuid);
COMMIT;
```

## Read-only health check

Run with Node.js as the operating-system user that owns the embedded instance:

```sh
node scripts/operators/check-legacy-recovery-hold-dedupe.mjs
node scripts/operators/check-legacy-recovery-hold-dedupe.mjs \
  --instance-dir /path/to/instance \
  --config /path/to/instance/config.json \
  --pg-module /path/to/installed/pg/esm/index.mjs
```

Defaults use the current user's home directory:
`~/.paperclip/instances/default`, its `config.json` and `db` directory, and
`~/.paperclip/cli/current/node_modules/pg/esm/index.mjs`. The equivalent environment
settings are `PAPERCLIP_INSTANCE_DIR`, `PAPERCLIP_CONFIG`, and `PAPERCLIP_PG_MODULE`;
explicit options take precedence. The `pg` entry point must be a trusted local
installed module; both ESM and CommonJS node-postgres entry points are supported.

The check accepts only embedded PostgreSQL, the selected instance's exact `db`
path, an empty connection string, and a valid configured port matching
`postmaster.pid`. It rejects nonempty `DATABASE_URL` overrides in the process or
instance `.env`, confirms the owner process exists, then connects to loopback
using the embedded `paperclip` database credentials. A read-only transaction
verifies the server's actual data directory, function signature, enabled trigger,
and absence of residual duplicate holds. It never invokes the mutating function.

Output is one JSON line; exit status is zero only for `healthy`. An unhealthy
result includes a reason, and trigger/residual-hold failures include diagnostic
counts. Connection and statement timeouts bound database checks. A healthy result
is a point-in-time catalog and evidence check, not proof that all concurrent
recovery states or function definitions match the captured source.

## Isolated regression test

After installing workspace dependencies:

```sh
node --test scripts/operators/recovery-hold-dedupe.test.mjs
```

The test creates a disposable embedded PostgreSQL cluster under `TMPDIR` (default
`/var/tmp`), chooses a loopback port, and removes the cluster afterward.
It uses a focused schema with the current column types and recovery uniqueness
constraint. It checks installation repeatability, evidence preservation, activity
logging, idempotency, tenant boundaries, run and lease guards, ambiguous holds,
trigger-error rollback, and health target validation. It does not access an
existing Paperclip database. PostgreSQL native runtime libraries must be available
for the workspace's `embedded-postgres` package.
