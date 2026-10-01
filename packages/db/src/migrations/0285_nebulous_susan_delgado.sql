CREATE TABLE "task_drain_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"instance_settings_id" uuid NOT NULL,
	"actions" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_drain_delegations" ADD CONSTRAINT "task_drain_delegations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_drain_delegations" ADD CONSTRAINT "task_drain_delegations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_drain_delegations" ADD CONSTRAINT "task_drain_delegations_instance_settings_id_instance_settings_id_fk" FOREIGN KEY ("instance_settings_id") REFERENCES "public"."instance_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_drain_delegations_agent_company_idx" ON "task_drain_delegations" USING btree ("agent_id","company_id");