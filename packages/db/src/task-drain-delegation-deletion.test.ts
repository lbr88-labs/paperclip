import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

(support.supported ? describe : describe.skip)("task drain grant deletion lifecycle", () => {
  it.each([
    ["expired", "agent"], ["revoked", "agent"],
    ["expired", "company"], ["revoked", "company"],
  ])("allows hard deletion with %s grants referencing the %s", async (state, subject) => {
    const database = await startEmbeddedPostgresTestDatabase("task-drain-deletion-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => { await sql.end(); });
    const companyId = randomUUID();
    const agentId = randomUUID();
    const [{ id: settingsId }] = await sql<{ id: string }[]>`SELECT id FROM instance_settings LIMIT 1`;
    await sql`INSERT INTO companies (id, name) VALUES (${companyId}, 'Deletion test')`;
    await sql`INSERT INTO agents (id, company_id, name, role) VALUES (${agentId}, ${companyId}, 'CEO', 'ceo')`;
    const insertGrant = async () => sql`INSERT INTO task_drain_delegations
      (agent_id, company_id, instance_id, instance_settings_id, actions, expires_at, issued_by_user_id, revoked_at)
      VALUES (${agentId}, ${companyId}, 'default', ${settingsId}, '["read"]',
        ${state === "expired" ? new Date(0) : new Date(Date.now() + 60_000)}, 'admin', ${state === "revoked" ? new Date() : null})`;
    await insertGrant();
    if (subject === "agent") {
      await sql`DELETE FROM agents WHERE id = ${agentId}`;
    } else {
      // Isolate this FK from agents' independent NO ACTION company FK.
      await sql`ALTER TABLE agents DROP CONSTRAINT agents_company_id_companies_id_fk`;
      await sql`DELETE FROM companies WHERE id = ${companyId}`;
    }
    expect(await sql`SELECT id FROM task_drain_delegations`).toHaveLength(0);
  }, 90_000);
});
