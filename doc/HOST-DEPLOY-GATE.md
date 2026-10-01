# Paperclip host deployment gate

`scripts/host-deploy-gate.py` is an optional host-side wrapper for deployments
that use a recorded deployment window and task-drain hold. It checks evidence
before running the exact replacement and restart commands recorded in a
manifest. It does not create or release a hold, choose a deployment target,
or replace an installation's existing deployment procedure.

## Decision manifest

Use a fresh JSON file for one deployment. Record the service, exact artifact,
current and target versions, impact, and deployment window in the referenced
issue document. The wrapper checks the following manifest fields; file paths
must be absolute and timestamps must use UTC with a `Z` suffix:

```json
{
  "version": 1,
  "service": "paperclipai.service",
  "apiBaseUrl": "http://127.0.0.1:3100",
  "decision": {"issueId": "DECISION-ISSUE-ID", "documentKey": "deployment-decision", "revisionId": "DOCUMENT-REVISION-ID"},
  "companyIds": ["EVERY-COMPANY-ID"],
  "notBefore": "RECORDED-WINDOW-START-UTC",
  "expiresAt": "RECORDED-WINDOW-END-UTC",
  "hold": {"startedAt": "EXACT-POST-RESPONSE-UTC", "expiresAt": "EXACT-POST-RESPONSE-UTC"},
  "commands": {"replace": ["/absolute/replacement-command"], "restart": ["/absolute/restart-command"]},
  "artifact": {"path": "/absolute/staged/artifact", "sha256": "64-lowercase-hex"},
  "backup": {"path": "/absolute/backup.sql.gz", "sha256": "64-lowercase-hex", "createdAt": "BACKUP-CREATION-UTC"},
  "restoreReceipt": {"path": "/absolute/restore.json", "sha256": "64-lowercase-hex"},
  "rollback": {"path": "/absolute/known-good-file", "sha256": "64-lowercase-hex"}
}
```

The isolated restore receipt itself must contain `result: "passed"`, the
backup SHA-256, the exact decision revision, and a UTC `verifiedAt` after
backup creation. The backup must be made inside the recorded window, less
than 15 minutes old at **both** gates, and checked with the supported backup
tool and an isolated restore before invoking the wrapper. The rollback file
must be the known-good installed version; rehearse its restore command. Keep
the manifest, artifact, backup, receipt and rollback file out of mutable
agent scratch. Restrict token, state, and report paths to the host operator.

## Controller sequence

1. Run the wrapper from a host process independent of Paperclip. Use an
   authorized board/instance-admin API token with access to the decision
   document, all companies, and task-drain state. Create a hold through the
   supported `POST /api/instance/task-drain` route, with a TTL covering the
   deployment window, and record its exact `startedAt` and `expiresAt`.
   A PID exit or CLI `drainRequired` value cannot establish this hold.
2. Record the full company ID list using an instance-wide authorized read.
   A company-scoped list may omit companies and cannot establish coverage.
   The gate compares the live `/api/companies` list to the manifest and reads
   each company's database-backed `/live-runs?minCount=0&limit=50`. A saturated
   50-row response fails because it may hide more rows. `running` and
   `reconnecting` rows count even without a worker PID. Queued rows are
   preserved and must remain identical across both snapshots.
3. From the independent host process, call
   `python3 scripts/host-deploy-gate.py --manifest /absolute/decision.json --phase replace -- /absolute/replacement-command`
   with an authorized board token in `PAPERCLIP_DEPLOY_API_TOKEN`. This command
   must perform **only** the reviewed live file replacement. The wrapper
   requires the command to match the exact manifest argument vector and
   verifies the current document revision, deadline, active process-local
   hold, zero process work, two identical zero-running database inventories
   separated by three seconds, backup/restore/rollback checksums, then runs
   the command. A nonzero exit aborts. It consumes the manifest before launching the command so
   a crash cannot silently replay replacement.
4. Immediately before restart, call the same wrapper with `--phase restart`
   and the reviewed restart command. All checks repeat, including two fresh
   inventories. The first phase must have succeeded for the same manifest
   bytes. A restart failure consumes the manifest; recovery requires a
   fresh recorded window and a new manifest. The caller must validate
   `/api/health`, real transcript production and affected queued outcomes,
   then record whether the known-good file or database restore was needed.

The wrapper creates `.state.json` and an append-only `.report.jsonl` beside
the manifest under a file lock. Each gate result and abort has a UTC timestamp
and decision revision. The host filesystem is operator-writable, so the
report is append-only by program behavior but **not tamper-proof storage**;
copy the final report to durable, access-controlled evidence. If report
storage itself fails, the command is not run. A new decision needs a new
manifest filename; never delete state to reuse an old decision.

## Validation and limitations

Run the mocked regression tests without contacting a live instance:

```sh
python3 -m unittest -v scripts/test_host_deploy_gate.py
```

The tests cover two-phase single use, expired windows, missing holds,
PID-less reconnecting work, changed revisions, corrupted backup evidence,
saturated inventories, and evidence becoming stale during checksum checks.
They do not validate a real backup restore or execute live deployment commands.

The wrapper targets `paperclipai.service` and `http://127.0.0.1:3100` only.
The inventory settle interval defaults to three seconds; `--settle-seconds`
accepts a positive value up to 30 seconds. File replacement and service restart
remain the responsibility of the supplied commands. The caller also manages
hold release and verifies post-deployment health and queued task outcomes.
