import type { Request } from "express";

const ISSUE_QUERY = "status=todo,in_progress,blocked,in_review&limit=100";

/** Exact HTTP contract for a status_read agent API key. */
export function statusReadRouteAllowed(method: string, originalUrl: string, companyId: string): boolean {
  if (method !== "GET") return false;
  return originalUrl === `/api/companies/${companyId}/issues?${ISSUE_QUERY}`
    || originalUrl === `/api/companies/${companyId}/agents`;
}

export function isStatusReadKeyActor(req: Request): boolean {
  return req.actor.type === "agent"
    && req.actor.source === "agent_key"
    && Boolean(req.actor.keyId)
    && req.actor.keyScope?.kind === "status_read";
}

export function projectStatusIssue(issue: {
  status: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
}) {
  return {
    status: issue.status,
    identifier: issue.identifier ?? "",
    title: issue.title,
    assigneeAgentId: issue.assigneeAgentId,
  };
}

export function projectStatusAgent(agent: { id: string; name: string }) {
  return { id: agent.id, name: agent.name };
}
