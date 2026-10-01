import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { instanceSettings } from "./instance_settings.js";

export type TaskDrainDelegationAction = "read" | "start" | "stop";

export const taskDrainDelegations = pgTable(
  "task_drain_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    instanceSettingsId: uuid("instance_settings_id").notNull().references(() => instanceSettings.id),
    actions: jsonb("actions").$type<TaskDrainDelegationAction[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    issuedByUserId: text("issued_by_user_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentCompanyIdx: index("task_drain_delegations_agent_company_idx").on(table.agentId, table.companyId),
  }),
);
