import { and, eq, isNull } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, taskDrainDelegations, type Db } from "@paperclipai/db";
import type { TaskDrainDelegationAction } from "@paperclipai/db/schema/task_drain_delegations";
import { forbidden } from "../errors.js";

export type TaskDrainGrant = typeof taskDrainDelegations.$inferSelect;

function isEligibleCeoAgent(agent: { companyId: string; role: string; status: string } | undefined, companyId: string) {
  return agent?.companyId === companyId && agent.role === "ceo" && agent.status !== "terminated";
}

export function grantAllowsTaskDrain(input: {
  grant: TaskDrainGrant;
  agentId: string;
  companyId: string;
  instanceId: string;
  instanceSettingsId: string;
  companyIds: string[];
  runStatus: string;
  action: TaskDrainDelegationAction;
  now: Date;
  ttlMs?: number | null;
}): boolean {
  const { grant, agentId, companyId, instanceId, instanceSettingsId, companyIds, runStatus, action, now, ttlMs } = input;
  if (grant.agentId !== agentId || grant.companyId !== companyId || grant.instanceId !== instanceId ||
    grant.instanceSettingsId !== instanceSettingsId || runStatus !== "running") return false;
  // The drain holds admission for the whole process. Never let a company-scoped
  // delegation affect an instance with a second company, even if it was added
  // after the grant was issued.
  if (companyIds.length !== 1 || companyIds[0] !== companyId) return false;
  if (grant.revokedAt || grant.expiresAt.getTime() <= now.getTime()) return false;
  if (!Array.isArray(grant.actions) || !grant.actions.includes(action)) return false;
  if (action === "start") {
    if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0) return false;
    if (now.getTime() + ttlMs > grant.expiresAt.getTime()) return false;
  }
  return true;
}

export function taskDrainDelegationService(db: Db) {
  return {
    async list() {
      return db.select().from(taskDrainDelegations);
    },
    async create(input: {
      agentId: string;
      companyId: string;
      instanceId: string;
      instanceSettingsId: string;
      actions: TaskDrainDelegationAction[];
      expiresAt: Date;
      issuedByUserId: string;
    }) {
      const [agent] = await db.select({ id: agents.id, companyId: agents.companyId, role: agents.role, status: agents.status })
        .from(agents).where(eq(agents.id, input.agentId));
      if (!isEligibleCeoAgent(agent, input.companyId)) {
        throw forbidden("Target agent must be the current CEO for this company");
      }
      return db.transaction(async (tx) => {
        const [grant] = await tx.insert(taskDrainDelegations).values(input).returning();
        await tx.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "user",
          actorId: input.issuedByUserId,
          action: "instance.task_drain.delegation_issued",
          entityType: "task_drain_delegation",
          entityId: grant.id,
          details: { agentId: input.agentId, instanceId: input.instanceId, instanceSettingsId: input.instanceSettingsId,
            actions: input.actions, expiresAt: input.expiresAt.toISOString() },
        });
        return grant;
      });
    },
    async revoke(id: string, revokedByUserId: string) {
      return db.transaction(async (tx) => {
        const [grant] = await tx.update(taskDrainDelegations)
          .set({ revokedAt: new Date(), revokedByUserId })
          .where(and(eq(taskDrainDelegations.id, id), isNull(taskDrainDelegations.revokedAt)))
          .returning();
        if (!grant) return null;
        await tx.insert(activityLog).values({
          companyId: grant.companyId,
          actorType: "user",
          actorId: revokedByUserId,
          action: "instance.task_drain.delegation_revoked",
          entityType: "task_drain_delegation",
          entityId: grant.id,
          details: { agentId: grant.agentId, instanceId: grant.instanceId, instanceSettingsId: grant.instanceSettingsId },
        });
        return grant;
      });
    },
    async authorize(input: {
      agentId: string;
      companyId: string;
      instanceId: string;
      instanceSettingsId: string;
      companyIds: string[];
      runId: string;
      action: TaskDrainDelegationAction;
      ttlMs?: number | null;
    }) {
      const [agent] = await db.select({ companyId: agents.companyId, role: agents.role, status: agents.status })
        .from(agents).where(eq(agents.id, input.agentId));
      if (!isEligibleCeoAgent(agent, input.companyId)) return null;
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.companyId, input.companyId),
      ));
      if (run?.status !== "running") return null;
      const grants = await db.select().from(taskDrainDelegations).where(and(
        eq(taskDrainDelegations.agentId, input.agentId),
        eq(taskDrainDelegations.companyId, input.companyId),
        eq(taskDrainDelegations.instanceSettingsId, input.instanceSettingsId),
        isNull(taskDrainDelegations.revokedAt),
      ));
      const now = new Date();
      return grants.find((grant) => grantAllowsTaskDrain({ ...input, runStatus: run.status, grant, now })) ?? null;
    },
  };
}
