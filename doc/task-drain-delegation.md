# Task-drain delegation

A signed-in instance-admin board session can grant the current CEO agent limited access to task drain. Agent JWTs and board API keys cannot create, list, inspect targets for, or revoke grants. Delegation does not issue a new bearer credential: the CEO uses its own active run JWT.

Task drain holds task admission across the server process. Delegation is supported only with exactly one company and one server process serving the instance. Operators must verify the single-process deployment before enabling delegation; the transition queue is process-local and does not coordinate multiple servers.

## Grant a maintenance window

1. Verify the deployed version, service health, fresh backups, and rollback procedure. Confirm that exactly one server process serves the database and API.
2. From the instance admin's same-origin board session, read `GET /api/instance/task-drain/delegations/target`. Verify `instanceId`, `instanceSettingsId`, the sole `companyId`, and `delegationSupported=true`. Read `GET /api/instance/task-drain/delegations` to inspect existing grants.
3. Send `POST /api/instance/task-drain/delegations` with:

   ```json
   {
     "agentId": "<CEO agent UUID>",
     "companyId": "<company UUID>",
     "instanceId": "<instance ID>",
     "instanceSettingsId": "<settings UUID>",
     "actions": ["read", "start", "stop"],
     "expiresAt": "<ISO timestamp>"
   }
   ```

   Choose only the necessary actions. Expiry must be between one minute and 24 hours away. Keep the returned grant ID for revocation. Duplicate actions, mismatched targets, and agents without the current CEO role are rejected.
4. In a fresh CEO run, verify the agent and company using `GET /api/agents/me`, then read `GET /api/instance/task-drain` with the injected run JWT. Never copy board sessions or JWTs into tasks or audit records.

## Use and revoke

The grant binds the CEO, company, instance ID, settings row, actions, and expiry. Every delegated call rechecks the current CEO role and running heartbeat. A second company, completed run, changed identity, expired grant, or revoked grant fails closed.

For `start`, send `POST /api/instance/task-drain` with finite positive `ttlMs`. The hold must end no later than grant expiry. Read back the drain state; use `DELETE /api/instance/task-drain` to stop if the grant permits it. Process-local `quiescent=true` does not prove zero persisted running rows. Independently verify running rows, backups, and rollback readiness before restarting the service.

The instance admin revokes with `DELETE /api/instance/task-drain/delegations/{grantId}` and confirms `revokedAt` through the list route. A subsequent CEO call must return 403. Revocation prevents future calls but does not release an existing hold: stop it with authorized board access or wait for its TTL.

Grant issuance and revocation are transactionally audited. Every delegated read, start, and stop records actor, run, and grant ID in the activity log. Grant rows follow their agent/company deletion lifecycle; deleting an agent removes its grants. Issuance and revocation activity records retain the grant ID; the existing agent removal service deletes delegated-use activity attributed to that agent. Company deletion follows the instance's existing company-data retention policy.

## Rollback

Revoke active grants before reverting the application payload. Verify health, normal task admission, and absence of a lingering hold afterward. The migration is additive; an application rollback can retain the delegation table. Without a live grant, a CEO run must receive 403 for task drain. Preserve a record of target, actions, expiry, revocation, and verification outcomes without credentials.
