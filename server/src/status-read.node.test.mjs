import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectStatusAgent,
  projectStatusIssue,
  statusReadRouteAllowed,
} from "./status-read.ts";

const company = "452da68b-2c6e-4b71-8cb7-9cd8580998c7";
const otherCompany = "00000000-0000-4000-8000-000000000000";
const issuePath = `/api/companies/${company}/issues?status=todo,in_progress,blocked,in_review&limit=100`;
const agentsPath = `/api/companies/${company}/agents`;

test("status scope accepts only the two exact same-company GETs", () => {
  assert.equal(statusReadRouteAllowed("GET", issuePath, company), true);
  assert.equal(statusReadRouteAllowed("GET", agentsPath, company), true);
  for (const path of [
    issuePath.replace(company, otherCompany),
    agentsPath.replace(company, otherCompany),
    `/api/companies/${company}/issues`,
    `${issuePath}&offset=100`,
    `${agentsPath}?q=all`,
    `/api/issues/00000000-0000-4000-8000-000000000000`,
  ]) {
    assert.equal(statusReadRouteAllowed("GET", path, company), false, path);
  }
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    assert.equal(statusReadRouteAllowed(method, issuePath, company), false, method);
    assert.equal(statusReadRouteAllowed(method, agentsPath, company), false, method);
  }
});

test("status responses contain only fields consumed by the HA candidate", () => {
  assert.deepEqual(projectStatusIssue({
    status: "in_progress", identifier: "HOM-99", title: "Example",
    assigneeAgentId: "agent-id", description: "must not leak",
  }), {
    status: "in_progress", identifier: "HOM-99", title: "Example",
    assigneeAgentId: "agent-id",
  });
  assert.deepEqual(projectStatusAgent({
    id: "agent-id", name: "Systems Maintainer", adapterConfig: { secret: "must not leak" },
  }), { id: "agent-id", name: "Systems Maintainer" });
  assert.equal(projectStatusIssue({
    status: "todo", identifier: null, title: "Unnumbered",
    assigneeAgentId: null,
  }).identifier, "");
});
