import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { agentService } from "../services/agents.js";
import type { StorageService } from "../storage/types.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe.sequential : describe.skip;
if (!support.supported) console.warn(`Skipping status-read HTTP test: ${support.reason}`);

const storage = {
  provider: "local_disk",
  async putFile() { throw new Error("unused"); },
  async getObject() { throw new Error("unused"); },
  async headObject() { return { exists: false }; },
  async deleteObject() {},
} as unknown as StorageService;

describeDatabase("status_read credential over HTTP", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-status-read-http-");
    db = createDb(temporary.connectionString);
  }, 20_000);

  afterAll(async () => temporary?.cleanup());

  it("issues a company-bound key, limits exact routes and fields, and revokes independently", async () => {
    const [company, otherCompany] = await db.insert(companies).values([
      { name: "Status source", issuePrefix: `SR${randomUUID().slice(0, 6).toUpperCase()}` },
      { name: "Other company", issuePrefix: `OT${randomUUID().slice(0, 6).toUpperCase()}` },
    ]).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company.id, name: "Status agent", role: "engineer", status: "active",
      adapterType: "process", adapterConfig: { privateValue: "hidden" }, runtimeConfig: {},
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id, identifier: `${company.issuePrefix}-1`, title: "Visible title",
      description: "hidden description", status: "in_progress", priority: "medium",
      assigneeAgentId: agent.id,
    }).returning();
    const responsibleUserId = `responsible-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: responsibleUserId, name: "Status test owner", email: `${responsibleUserId}@example.test`,
      emailVerified: true, createdAt: now, updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: responsibleUserId,
      status: "active", membershipRole: "member",
    });

    const service = agentService(db);
    const wrongCompany = service.createApiKey(agent.id, "wrong company", {
      kind: "status_read", companyId: otherCompany.id,
    }, { responsibleUserId });
    await expect(wrongCompany).rejects.toThrow();
    const statusKey = await service.createApiKey(agent.id, "status test", {
      kind: "status_read", companyId: company.id,
    }, { responsibleUserId });
    const normalKey = await service.createApiKey(agent.id, "normal test", {
      kind: "standard",
    }, { responsibleUserId });

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", agentRoutes(db, { deploymentMode: "authenticated" }));
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
    const api = request(app);
    const issuesPath = `/api/companies/${company.id}/issues?status=todo,in_progress,blocked,in_review&limit=100`;
    const agentsPath = `/api/companies/${company.id}/agents`;
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

    const issueResponse = await api.get(issuesPath).set(auth(statusKey.token));
    expect(issueResponse.status).toBe(200);
    expect(issueResponse.body).toHaveLength(1);
    expect(issueResponse.body[0]).toEqual({
      status: "in_progress", identifier: issue.identifier, title: issue.title,
      assigneeAgentId: agent.id,
    });
    const agentResponse = await api.get(agentsPath).set(auth(statusKey.token));
    expect(agentResponse.status).toBe(200);
    expect(agentResponse.body).toEqual([{ id: agent.id, name: agent.name }]);

    for (const path of [issuesPath.replace(company.id, otherCompany.id), agentsPath.replace(company.id, otherCompany.id),
      `${issuesPath}&offset=100`, `${agentsPath}?limit=1`, `/api/issues/${issue.id}`]) {
      expect((await api.get(path).set(auth(statusKey.token))).status, path).toBe(403);
    }
    for (const [method, path] of [
      ["post", `/api/companies/${company.id}/issues`],
      ["patch", `/api/issues/${issue.id}`],
      ["post", `/api/issues/${issue.id}/comments`],
      ["delete", `/api/agents/${agent.id}/keys/${statusKey.id}`],
    ] as const) {
      expect((await api[method](path).set(auth(statusKey.token)).send({ title: "denied", body: "denied" })).status,
        `${method.toUpperCase()} ${path}`).toBe(403);
    }
    expect((await api.get(issuesPath).set(auth("invalid-test-key"))).status).toBe(401);

    await db.update(agentApiKeys).set({ scopeConfig: { kind: "status_read", companyId: otherCompany.id } })
      .where(eq(agentApiKeys.id, statusKey.id));
    expect((await api.get(issuesPath).set(auth(statusKey.token))).status).toBe(403);
    await db.update(agentApiKeys).set({ scopeConfig: { kind: "status_read", companyId: "malformed" } as any })
      .where(eq(agentApiKeys.id, statusKey.id));
    expect((await api.get(issuesPath).set(auth(statusKey.token))).status).toBe(403);
    await db.update(agentApiKeys).set({ scopeConfig: { kind: "status_read", companyId: company.id } })
      .where(eq(agentApiKeys.id, statusKey.id));
    expect((await api.get(issuesPath).set(auth(statusKey.token))).status).toBe(200);

    expect(await service.revokeKey(agent.id, statusKey.id)).toBeTruthy();
    expect((await api.get(issuesPath).set(auth(statusKey.token))).status).toBe(401);
    expect((await api.get(agentsPath).set(auth(normalKey.token))).status).toBe(200);
  }, 30_000);
});
