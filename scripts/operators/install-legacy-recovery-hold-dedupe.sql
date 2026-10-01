BEGIN;

CREATE OR REPLACE FUNCTION public.paperclip_dedupe_legacy_recovery_holds(p_action_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_probe public.issue_recovery_actions%ROWTYPE;
    v_action public.issue_recovery_actions%ROWTYPE;
    v_issue public.issues%ROWTYPE;
    v_run public.heartbeat_runs%ROWTYPE;
    v_hold public.issue_recovery_actions%ROWTYPE;
    v_hold_ids uuid[] := ARRAY[]::uuid[];
    v_hold_id uuid;
    v_updated integer := 0;
BEGIN
    IF p_action_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT * INTO v_probe
    FROM public.issue_recovery_actions
    WHERE id = p_action_id;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- Paperclip locks the issue before resolving the action; serialize manual calls the same way.
    SELECT * INTO v_issue
    FROM public.issues
    WHERE id = v_probe.source_issue_id AND company_id = v_probe.company_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    SELECT * INTO v_action
    FROM public.issue_recovery_actions
    WHERE id = p_action_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    IF v_action.company_id <> v_issue.company_id
       OR v_action.source_issue_id <> v_issue.id
       OR v_action.status <> 'resolved'
       OR v_action.cause <> 'legacy_execution_requires_reconciliation'
       OR v_action.kind <> 'active_run_watchdog'
       OR v_action.owner_type <> 'board'
       OR v_action.owner_agent_id IS NOT NULL
       OR v_action.owner_user_id IS NOT NULL
       OR v_action.return_owner_agent_id IS NULL
       OR v_action.return_owner_agent_id IS DISTINCT FROM v_issue.assignee_agent_id
       OR v_action.outcome IS DISTINCT FROM 'handed_back'
       OR v_action.resolved_at IS NULL
       OR v_action.wake_policy IS NOT NULL
       OR v_action.monitor_policy IS NOT NULL
       OR v_action.evidence->>'continuationDelivery' IS DISTINCT FROM 'pending'
       OR v_action.evidence ? 'continuationRunId'
       OR v_action.evidence ? 'continuationDeliveryOwner'
       OR v_action.evidence ? 'automaticRecovery'
       OR v_action.evidence->'executionReconciliation'->'providerStopped' IS DISTINCT FROM 'true'::jsonb
       OR coalesce(v_action.evidence #>> '{executionReconciliation,actionOutcome}', '') NOT IN ('completed', 'not_performed', 'mixed')
       OR length(btrim(coalesce(v_action.evidence #>> '{executionReconciliation,outcomeEvidence}', ''))) < 20
       OR v_issue.status <> 'todo'
       OR v_issue.hidden_at IS NOT NULL
       OR v_issue.assignee_agent_id IS NULL
       OR v_issue.assignee_user_id IS NOT NULL
       OR v_issue.execution_run_id IS NOT NULL
       OR v_issue.checkout_run_id IS NOT NULL
       OR v_issue.conversation_agent_id IS NOT NULL
       OR v_issue.conversation_user_id IS NOT NULL THEN
        RETURN 0;
    END IF;

    IF v_action.evidence->>'runId' IS NULL
       OR v_action.evidence->>'runId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR v_action.evidence->>'runId' IS DISTINCT FROM v_action.evidence #>> '{executionReconciliation,runId}'
       OR v_action.fingerprint IS DISTINCT FROM 'legacy-execution:' || (v_action.evidence->>'runId') THEN
        RETURN 0;
    END IF;

    SELECT * INTO v_run
    FROM public.heartbeat_runs
    WHERE id = (v_action.evidence->>'runId')::uuid
      AND company_id = v_action.company_id;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    IF v_run.status NOT IN ('failed', 'timed_out', 'interrupted', 'cancelled')
       OR v_run.finished_at IS NULL
       OR v_run.scheduled_retry_at IS NOT NULL
       OR v_run.runtime_mode <> 'legacy'
       OR v_run.agent_id IS DISTINCT FROM v_issue.assignee_agent_id
       OR coalesce(v_run.native_issue_id::text, v_run.context_snapshot->>'issueId') IS DISTINCT FROM v_issue.id::text THEN
        RETURN 0;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.heartbeat_runs r
        WHERE r.company_id = v_action.company_id
          AND r.id <> v_run.id
          AND (
              r.retry_of_run_id = v_run.id
              OR r.context_snapshot->>'previousRunId' = v_run.id::text
              OR r.context_snapshot->>'retryOfRunId' = v_run.id::text
              OR r.context_snapshot->>'recoveryActionId' = v_action.id::text
          )
    ) OR EXISTS (
        SELECT 1 FROM public.heartbeat_runs r
        WHERE r.company_id = v_action.company_id
          AND r.status IN ('queued', 'scheduled_retry', 'running')
          AND (
              r.native_issue_id = v_issue.id
              OR r.context_snapshot->>'issueId' = v_issue.id::text
              OR r.context_snapshot->>'taskId' = v_issue.id::text
              OR r.context_snapshot->>'taskKey' IN (v_issue.id::text, v_issue.identifier)
          )
    ) OR EXISTS (
        SELECT 1 FROM public.native_run_finalizations f
        WHERE f.company_id = v_action.company_id
          AND f.run_id = v_run.id
          AND (
              f.lease_owner IS NOT NULL
              OR f.result_id IS NOT NULL
              OR coalesce(f.failure_detail->>'successorRunId', '') <> ''
              OR f.phase <> 'terminal_failure'
          )
    ) OR EXISTS (
        SELECT 1 FROM public.environment_leases l
        WHERE l.company_id = v_action.company_id
          AND l.heartbeat_run_id = v_run.id
          AND l.released_at IS NULL
    ) THEN
        RETURN 0;
    END IF;

    -- Scan and lock all actions before changing any: one ambiguous hold rejects the entire batch.
    FOR v_hold IN
        SELECT * FROM public.issue_recovery_actions
        WHERE company_id = v_action.company_id
          AND source_issue_id = v_action.source_issue_id
        ORDER BY created_at, id
        FOR UPDATE
    LOOP
        IF v_hold.id = v_action.id THEN
            CONTINUE;
        END IF;
        IF v_hold.evidence->>'continuationDelivery' = 'pending'
           OR v_hold.status IN ('active', 'escalated') THEN
            RETURN 0;
        END IF;
        IF v_hold.evidence #>> '{automaticRecovery,replay}' = 'blocked' THEN
            IF v_hold.status <> 'resolved'
               OR v_hold.outcome IS DISTINCT FROM 'blocked'
               OR v_hold.cause <> v_action.cause
               OR v_hold.kind <> v_action.kind
               OR v_hold.fingerprint <> v_action.fingerprint
               OR v_hold.created_at >= v_action.created_at
               OR v_hold.resolved_at IS NULL
               OR v_hold.resolved_at >= v_action.resolved_at
               OR v_hold.owner_type <> 'board'
               OR v_hold.owner_agent_id IS NOT NULL
               OR v_hold.owner_user_id IS NOT NULL
               OR v_hold.return_owner_agent_id IS DISTINCT FROM v_action.return_owner_agent_id
               OR v_hold.wake_policy IS NOT NULL
               OR v_hold.monitor_policy IS NOT NULL
               OR v_hold.evidence->>'runId' IS DISTINCT FROM v_run.id::text
               OR jsonb_typeof(v_hold.evidence->'automaticRecovery') IS DISTINCT FROM 'object'
               OR v_hold.evidence #>> '{automaticRecovery,runId}' IS DISTINCT FROM v_run.id::text
               OR v_hold.evidence #>> '{automaticRecovery,policy}' IS DISTINCT FROM 'preserve_without_replay_v1'
               OR v_hold.evidence ? 'continuationDelivery'
               OR v_hold.evidence ? 'continuationDeliveryOwner'
               OR v_hold.evidence ? 'continuationRunId'
               OR v_hold.evidence ? 'executionReconciliation'
               OR v_hold.evidence ? 'supersededNoReplayHold' THEN
                RETURN 0;
            END IF;
            v_hold_ids := array_append(v_hold_ids, v_hold.id);
        END IF;
    END LOOP;

    IF cardinality(v_hold_ids) = 0 THEN
        RETURN 0;
    END IF;

    FOREACH v_hold_id IN ARRAY v_hold_ids LOOP
        SELECT * INTO v_hold
        FROM public.issue_recovery_actions
        WHERE id = v_hold_id
        FOR UPDATE;

        UPDATE public.issue_recovery_actions
        SET evidence = jsonb_set(
                jsonb_set(v_hold.evidence, '{automaticRecovery}',
                          (v_hold.evidence->'automaticRecovery') - 'replay', false),
                '{supersededNoReplayHold}',
                jsonb_build_object(
                    'automaticRecovery', v_hold.evidence->'automaticRecovery',
                    'canonicalActionId', v_action.id::text,
                    'recordedAt', clock_timestamp()),
                true),
            updated_at = clock_timestamp()
        WHERE id = v_hold_id
          AND company_id = v_action.company_id
          AND source_issue_id = v_action.source_issue_id
          AND status = 'resolved'
          AND evidence = v_hold.evidence;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Recovery hold % changed during deduplication', v_hold_id;
        END IF;

        INSERT INTO public.activity_log (
            company_id, actor_type, actor_id, action, entity_type, entity_id,
            run_id, responsible_user_id, details
        ) VALUES (
            v_action.company_id, 'system', 'paperclip-recovery-trigger',
            'issue.execution_recovery_hold_superseded', 'issue', v_issue.id::text,
            v_run.id,
            coalesce(v_issue.responsible_user_id, v_issue.created_by_user_id, v_run.responsible_user_id),
            jsonb_build_object(
                'recoveryActionId', v_hold_id::text,
                'canonicalRecoveryActionId', v_action.id::text,
                'runId', v_run.id::text,
                'fingerprint', v_action.fingerprint)
        );
        v_updated := v_updated + 1;
    END LOOP;

    RETURN v_updated;
END;
$function$;

CREATE OR REPLACE FUNCTION public.paperclip_dedupe_legacy_recovery_holds_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    BEGIN
        PERFORM public.paperclip_dedupe_legacy_recovery_holds(NEW.id);
    EXCEPTION WHEN OTHERS THEN
        -- A failed dedupe rolls back its own writes, never the Paperclip resolution.
        RAISE WARNING 'Recovery hold dedupe skipped for action % (SQLSTATE %): %',
            NEW.id, SQLSTATE, SQLERRM;
    END;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS paperclip_dedupe_legacy_recovery_holds_on_resolve
    ON public.issue_recovery_actions;
CREATE TRIGGER paperclip_dedupe_legacy_recovery_holds_on_resolve
AFTER UPDATE OF status ON public.issue_recovery_actions
FOR EACH ROW
WHEN (
    OLD.status IN ('active', 'escalated')
    AND NEW.status = 'resolved'
    AND NEW.cause = 'legacy_execution_requires_reconciliation'
)
EXECUTE FUNCTION public.paperclip_dedupe_legacy_recovery_holds_trigger();

COMMIT;
