import { describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, taskDrainDelegations } from "@paperclipai/db";
import { grantAllowsTaskDrain, taskDrainDelegationService, type TaskDrainGrant } from "../services/task-drain-delegation.js";

const now = new Date("2026-09-27T21:00:00.000Z");
const grant = {
  id: "grant-1",
  agentId: "ceo-agent",
  companyId: "home-company",
  instanceId: "default",
  instanceSettingsId: "paperclip-instance",
  actions: ["read", "start", "stop"],
  expiresAt: new Date("2026-09-27T22:00:00.000Z"),
  revokedAt: null,
} as TaskDrainGrant;
const base = {
  grant,
  agentId: "ceo-agent",
  companyId: "home-company",
  instanceId: "default",
  instanceSettingsId: "paperclip-instance",
  companyIds: ["home-company"],
  runStatus: "running",
  now,
} as const;

describe("task-drain delegation evaluator", () => {
  it("allows only the exact approved actions while live", () => {
    expect(grantAllowsTaskDrain({ ...base, action: "read" })).toBe(true);
    expect(grantAllowsTaskDrain({ ...base, action: "stop" })).toBe(true);
    expect(grantAllowsTaskDrain({ ...base, action: "start", ttlMs: 60_000 })).toBe(true);
    expect(grantAllowsTaskDrain({ ...base, grant: { ...grant, actions: ["read"] }, action: "stop" })).toBe(false);
  });

  it("rejects a different agent, company or instance and a second company on the process", () => {
    expect(grantAllowsTaskDrain({ ...base, agentId: "other", action: "read" })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, companyId: "other", action: "read" })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, instanceId: "other", action: "read" })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, instanceSettingsId: "other", action: "read" })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, companyIds: ["home-company", "other"], action: "read" })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, runStatus: "succeeded", action: "read" })).toBe(false);
  });

  it("rejects expiry and revocation immediately", () => {
    expect(grantAllowsTaskDrain({ ...base, now: grant.expiresAt, action: "read" })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, grant: { ...grant, revokedAt: now }, action: "read" })).toBe(false);
  });

  it("requires a finite start TTL wholly inside the grant lifetime", () => {
    expect(grantAllowsTaskDrain({ ...base, action: "start" })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, action: "start", ttlMs: null })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, action: "start", ttlMs: 0 })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, action: "start", ttlMs: 3_600_001 })).toBe(false);
    expect(grantAllowsTaskDrain({ ...base, action: "start", ttlMs: 3_600_000 })).toBe(true);
  });
});

describe("CEO role is checked against the current agent row", () => {
  it("denies issuance to a non-CEO before inserting a grant", async () => {
    const transaction = vi.fn();
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ companyId: "home-company", role: "manager", status: "active" }] }) }),
      transaction,
    } as any;
    await expect(taskDrainDelegationService(db).create({
      agentId: "other-agent", companyId: "home-company", instanceId: "default",
      instanceSettingsId: "paperclip-instance", actions: ["read"],
      expiresAt: grant.expiresAt, issuedByUserId: "admin-user",
    })).rejects.toMatchObject({ status: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("denies use by a non-CEO before looking up any grant", async () => {
    const select = vi.fn(() => ({ from: () => ({ where: async () => [{
      companyId: "home-company", role: "manager", status: "active",
    }] }) }));
    const result = await taskDrainDelegationService({ select } as any).authorize({
      agentId: "other-agent", companyId: "home-company", instanceId: "default",
      instanceSettingsId: "paperclip-instance", companyIds: ["home-company"],
      runId: "active-run", action: "read",
    });
    expect(result).toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("denies an existing grant after the agent loses the CEO role", async () => {
    let currentRole = "ceo";
    const activeGrant = { ...grant, expiresAt: new Date("2099-01-01T00:00:00.000Z") };
    const select = vi.fn(() => ({ from: (table: unknown) => ({ where: async () => {
      if (table === agents) return [{ companyId: "home-company", role: currentRole, status: "active" }];
      if (table === heartbeatRuns) return [{ status: "running" }];
      if (table === taskDrainDelegations) return [activeGrant];
      return [];
    } }) }));
    const db = { select } as any;
    const input = {
      agentId: "ceo-agent", companyId: "home-company", instanceId: "default",
      instanceSettingsId: "paperclip-instance", companyIds: ["home-company"],
      runId: "active-run", action: "read",
    } as const;
    const service = taskDrainDelegationService(db);
    expect(await service.authorize(input)).toMatchObject({ id: "grant-1" });
    currentRole = "manager";
    select.mockClear();
    const result = await service.authorize(input);
    expect(result).toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
  });
});
