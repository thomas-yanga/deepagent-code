import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./plan-write.txt"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "../session/schema"
import { NonNegativeInt } from "@deepagent-code/core/schema"

// U2: the live plan event. Published after each authority version change so the app can render a
// persistent plan panel (goal + steps + progress). Mirrors todo.updated in the same SSE stream.
const PlanStepEvent = Schema.Struct({
  step_id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  acceptance: Schema.optional(Schema.NullOr(Schema.String)),
  assigned_agent: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
  evidence: Schema.optional(Schema.Array(Schema.String)),
})
export const PlanEvent = {
  Updated: EventV2.define({
    type: "plan.updated",
    schema: {
      sessionID: SessionID,
      plan_id: Schema.String,
      goal: Schema.String,
      plan_version: Schema.Number,
      assumptions: Schema.Array(Schema.String),
      active_step_id: Schema.NullOr(Schema.String),
      steps: Schema.Array(PlanStepEvent),
      done: Schema.Number,
      total: Schema.Number,
      // U10: runtime-computed status transitions this write produced ("Title: from→to"). Lets the UI
      // and logs show WHAT changed, derived from before/after — not from the model's prose.
      changes: Schema.optional(Schema.Array(Schema.String)),
    },
  }),
}

// U1 PlanController write tool. The model calls this to create/update its working plan. Committing a
// semantic change clears a stale latch, which unblocks the soft gate after the runtime flagged the
// plan as out of date; a no-op acknowledgement deliberately leaves the latch unchanged.

const PlanStep = Schema.Struct({
  step_id: Schema.optional(Schema.String).annotate({
    description: "Stable id; required for advance, omit only when create/replan should allocate a new identity",
  }),
  title: Schema.optional(Schema.String).annotate({
    description:
      "What this step does. Required for create/replan. Optional for advance: the runtime merges the authoritative title — never restate it",
  }),
  status: Schema.String.annotate({ description: "pending | active | done | cancelled | blocked" }),
  // No NullOr: a nested optional(NullOr(...)) emits a double-nested anyOf whose inner
  // {type:null} survives normalize() and is rejected by some third-party providers (no-reply).
  // Optional already covers "absent"; strict admission normalizes missing values to null.
  acceptance: Schema.optional(Schema.String).annotate({
    description: "How you know this step is done. Only for create/replan; advance ignores restatements",
  }),
  assigned_agent: Schema.optional(Schema.String).annotate({
    description: "Subagent type to delegate to. Only for create/replan; advance ignores restatements",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Short note; REQUIRED when status is 'blocked' — say why you are stuck",
  }),
})

export const Parameters = Schema.Struct({
  operation: Schema.Literals(["create", "advance", "replan"]).annotate({
    description: "create a plan, advance an existing plan, or replan with a reason",
  }),
  expected_plan_id: Schema.NullOr(Schema.String),
  expected_version: Schema.NullOr(NonNegativeInt),
  replan_reason: Schema.optional(Schema.String),
  goal: Schema.optional(
    Schema.String.annotate({
      description:
        "One sentence: what 'done' means for this task. Required for create/replan. Optional for advance: the authoritative goal is preserved",
    }),
  ),
  steps: Schema.mutable(Schema.Array(PlanStep)).annotate({
    description:
      "Ordered plan steps. For advance, list only the steps whose status/note changes (with their stable step_id) — other steps are preserved",
  }),
  assumptions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Facts the plan relies on",
  }),
  active_step_id: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description:
        "The step currently being worked on. Omit on advance to keep the current active step; null clears it",
    }),
  ),
})
export const PlanWriteParameters = Parameters

type Metadata = {
  plan_id: string
  goal: string
  done: number
  total: number
  plan_protocol?: "success" | "invalid" | "conflict" | "no_progress"
  plan_progress?: boolean
  plan_version?: number
  plan_attempt_ordinal?: number
  plan_error_code?: string
  challenge_id?: string
}

import type { PlanDoc, PlanExpected, PlanWriteInput } from "@deepagent-code/core/deepagent/plan-controller"

// BUG-006-407: the model-facing `advance` operation is a server-merged status patch, NOT a full
// document reconstruction. The model only owns existing step_ids' `status`, `note`, and the
// active-step intent; goal/assumptions/order/titles/acceptance/assigned_agent are restored from the
// authoritative plan before the strict core builder runs. create/replan stay full structural writes.
export type ModelPlanWriteInput = Schema.Schema.Type<typeof Parameters>

// The exact model-facing fields the runtime hands back after a commit or a rejection so the NEXT
// write can copy them verbatim (expected_plan_id / expected_version / step_id+status / active id).
const retryBase = (previous: PlanDoc, version: number) => ({
  operation: "advance" as const,
  expected_plan_id: previous.plan_id,
  expected_version: version,
  active_step_id: previous.active_step_id,
  steps: previous.steps.map((step) => ({
    step_id: step.step_id,
    status: step.status,
    ...(step.note != null && step.note.trim() !== "" ? { note: step.note } : {}),
  })),
})

// Merge a model `advance` patch into the current authority, or pass through to the strict core
// contract for create/replan (and for advance when no authority exists yet — plan_missing there).
export const normalizeModelPlanWrite = (input: {
  readonly params: ModelPlanWriteInput
  readonly previous: PlanDoc | null
  readonly ref: PlanExpected | null
}): PlanWriteInput => {
  const { params, previous, ref } = input
  if (params.operation !== "advance" || previous == null || ref == null) {
    return {
      operation: params.operation,
      expected_plan_id: params.expected_plan_id,
      expected_version: params.expected_version,
      ...(params.replan_reason !== undefined ? { replan_reason: params.replan_reason } : {}),
      goal: params.goal ?? "",
      ...(params.assumptions !== undefined ? { assumptions: params.assumptions } : {}),
      steps: params.steps.map((step) => ({
        ...(step.step_id !== undefined ? { step_id: step.step_id } : {}),
        title: step.title ?? "",
        status: step.status,
        ...(step.acceptance !== undefined ? { acceptance: step.acceptance } : {}),
        ...(step.assigned_agent !== undefined ? { assigned_agent: step.assigned_agent } : {}),
        ...(step.note !== undefined ? { note: step.note } : {}),
      })),
      active_step_id: params.active_step_id ?? null,
    }
  }
  // Verify the version precondition BEFORE interpreting step identities: a stale writer after a
  // concurrent replan deterministically sees PlanConflictError, never a misleading unknown-step id.
  if (
    params.expected_plan_id == null ||
    params.expected_version == null ||
    params.expected_plan_id !== previous.plan_id ||
    params.expected_version !== ref.version
  ) {
    throw new AgentGateway.DeepAgentPlanController.PlanConflictError(
      params.expected_plan_id != null && params.expected_version != null
        ? { plan_id: params.expected_plan_id, doc_id: ref.doc_id, version: params.expected_version }
        : null,
      { plan_id: previous.plan_id, doc_id: ref.doc_id, version: ref.version },
    )
  }
  // The patch may only reference steps that already exist, each exactly once.
  const authorityById = new Map(previous.steps.map((step) => [step.step_id, step] as const))
  const seen = new Set<string>()
  const duplicates: string[] = []
  const unknown: string[] = []
  const patchById = new Map<string, ModelPlanWriteInput["steps"][number]>()
  for (const step of params.steps) {
    const id = (step.step_id ?? "").trim()
    if (id === "" || !authorityById.has(id)) {
      unknown.push(id)
      continue
    }
    if (seen.has(id)) {
      duplicates.push(id)
      continue
    }
    seen.add(id)
    patchById.set(id, step)
  }
  if (unknown.length > 0) {
    throw new AgentGateway.DeepAgentPlanController.PlanValidationError(
      "unsafe_step_identity",
      unknown,
      previous.plan_id,
      ref.version,
    )
  }
  if (duplicates.length > 0) {
    throw new AgentGateway.DeepAgentPlanController.PlanValidationError(
      "duplicate_step_id",
      duplicates,
      previous.plan_id,
      ref.version,
    )
  }
  // Merge over the AUTHORITATIVE step order. goal/assumptions/title/acceptance/assigned_agent come
  // from the authority even when the model restates them; only status/note/active-step intent from
  // the patch survives. Steps absent from the patch are preserved unchanged.
  const mergedSteps = previous.steps.map((step) => {
    const patch = patchById.get(step.step_id)
    if (!patch) {
      return {
        step_id: step.step_id,
        title: step.title,
        status: step.status,
        acceptance: step.acceptance,
        assigned_agent: step.assigned_agent,
        note: step.note,
      }
    }
    return {
      step_id: step.step_id,
      title: step.title,
      status: patch.status,
      acceptance: step.acceptance,
      assigned_agent: step.assigned_agent,
      note: patch.note !== undefined ? patch.note : step.note,
    }
  })
  return {
    operation: "advance",
    expected_plan_id: params.expected_plan_id,
    expected_version: params.expected_version,
    goal: previous.goal,
    assumptions: previous.assumptions,
    steps: mergedSteps,
    // omitted active_step_id = retain the current one; explicit null = clear it
    active_step_id: params.active_step_id === undefined ? previous.active_step_id : params.active_step_id,
  }
}

export const PlanTool = Tool.define<typeof Parameters, Metadata, EventV2Bridge.Service>(
  "plan",
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // ToolSequenceTracker must compare the plan's semantic proposal rather than display text or
      // object key order. The version/precondition remains part of the fingerprint so repeated stale
      // retries are visible, while runtime evidence is intentionally excluded from model input.
      // ToolSequenceTracker must compare the plan's semantic proposal rather than display text or
      // object key order. The version/precondition remains part of the fingerprint so repeated stale
      // retries are visible, while runtime evidence is intentionally excluded from model input.
      // BUG-006-407: for `advance` the server owns goal/assumptions/title/acceptance/assigned_agent,
      // so a model restatement of those fields must NOT change the proposal identity. An omitted
      // active_step_id is the explicit "retain" intent, distinct from null (clear).
      semanticFingerprint: (input: Schema.Schema.Type<typeof Parameters>) => {
        const advance = input.operation === "advance"
        return {
          operation: input.operation,
          expected_plan_id: input.expected_plan_id,
          expected_version: input.expected_version,
          replan_reason: input.replan_reason ?? null,
          goal: advance ? null : (input.goal ?? "").trim(),
          assumptions: advance ? [] : (input.assumptions ?? []).map((value) => value.trim()),
          active_step_id: advance
            ? input.active_step_id === undefined
              ? "retain"
              : input.active_step_id
            : (input.active_step_id ?? null),
          steps: input.steps.map((step) => ({
            step_id: step.step_id ?? null,
            title: advance ? null : (step.title ?? "").trim(),
            status: step.status.trim().toLowerCase(),
            acceptance: advance ? null : (step.acceptance ?? null),
            assigned_agent: advance ? null : (step.assigned_agent ?? null),
            note: step.note ?? null,
          })),
        }
      },
      resultFingerprint: (result) => ({
        plan_protocol: result.metadata.plan_protocol ?? null,
        plan_progress: result.metadata.plan_progress ?? null,
        plan_id: result.metadata.plan_id,
        plan_version: result.metadata.plan_version ?? null,
        done: result.metadata.done,
        total: result.metadata.total,
      }),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "plan", patterns: ["*"], always: ["*"], metadata: {} })

          const previous = AgentGateway.DeepAgentPlanStore.getPlanDoc(ctx.sessionID)
          const ref = AgentGateway.DeepAgentPlanStore.planDocRef(ctx.sessionID)
          const expectedRef =
            previous && ref
              ? {
                  plan_id: previous.plan_id,
                  doc_id: ref.id,
                  version: ref.version,
                }
              : null
          const attempt = yield* Effect.try({
            try: () => {
              // BUG-006-407: at the model boundary an `advance` is a status patch merged against the
              // current authority into a full candidate before the strict core builder runs.
              const writeInput = normalizeModelPlanWrite({ params, previous, ref: expectedRef })
              const built = AgentGateway.DeepAgentPlanController.buildPlanFromWriteInput(
                ctx.sessionID,
                writeInput,
                previous,
                expectedRef,
              )
              // The runtime supplies validation evidence only after semantic admission succeeds.
              const plan = AgentGateway.DeepAgentPlanController.attachEvidenceToNewlyDone(
                previous,
                built,
                AgentGateway.DeepAgentSessionState.lastValidationSummary(ctx.sessionID),
              )
              const committed = AgentGateway.DeepAgentPlanStore.compareAndCommitPlan({
                sessionId: ctx.sessionID,
                expected: expectedRef,
                candidate: plan,
                origin: "model_tool",
              })
              AgentGateway.DeepAgentSessionState.bindPlan(ctx.sessionID, committed.plan, previous, committed.changed)
              return {
                previous,
                plan: committed.plan,
                version: committed.version,
                changed: committed.changed,
                changes: AgentGateway.DeepAgentPlanController.diffStepStatuses(previous, committed.plan),
              }
            },
            catch: (error) => error,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          )

          if (!attempt.ok) {
            const error = attempt.error
            // Every rejection returns the authoritative retry base with the exact model-facing field
            // names so the next call can copy them verbatim (never infer ids/versions from prose).
            const base =
              previous && ref
                ? `\n\nAuthoritative retry base:\n${JSON.stringify(retryBase(previous, ref.version), null, 2)}`
                : ""
            if (error instanceof AgentGateway.DeepAgentPlanController.PlanConflictError) {
              const conflict = error
              return {
                title: "Plan conflict",
                output:
                  "The plan changed before this update was committed. Re-read the current plan and retry with its exact plan_id and version." +
                  base,
                metadata: {
                  plan_id: conflict.actual?.plan_id ?? previous?.plan_id ?? "",
                  goal: previous?.goal ?? params.goal ?? "",
                  done: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).done : 0,
                  total: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).total : 0,
                  plan_protocol: "conflict",
                  plan_error_code: "plan_conflict",
                  plan_version: conflict.actual?.version ?? ref?.version ?? 0,
                },
              }
            }
            if (error instanceof AgentGateway.DeepAgentPlanController.PlanValidationError) {
              const validation = error
              return {
                title: "Plan needs correction",
                output:
                  `The plan was not committed (${validation.code}). Correct the plan payload and retry once.${validation.challenge_id ? ` Confirmation: ${validation.challenge_id}` : ""}` +
                  base,
                metadata: {
                  plan_id: previous?.plan_id ?? "",
                  goal: previous?.goal ?? params.goal ?? "",
                  done: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).done : 0,
                  total: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).total : 0,
                  plan_protocol: "invalid",
                  plan_error_code: validation.code,
                  ...(validation.challenge_id ? { challenge_id: validation.challenge_id } : {}),
                  ...(ref ? { plan_version: ref.version } : {}),
                },
              }
            }
            return yield* Effect.die(error)
          }

          const { previous: prior, plan, version, changed, changes } = attempt.value

          const { done, total } = AgentGateway.DeepAgentPlanController.planProgress(plan)
          const changeLines = changes.map((c) => AgentGateway.DeepAgentPlanController.formatStepChange(c))
          // U10: soft advisory — a step declared `done` whose acceptance criterion has no passing
          // validation on record is flagged (not blocked): the model may be marking done prematurely.
          const acceptanceWarnings = plan.steps
            .filter(
              (s) =>
                s.status === "done" &&
                s.acceptance != null &&
                s.acceptance.trim() !== "" &&
                (s.evidence == null || s.evidence.length === 0),
            )
            .map((s) => `"${s.title}" is done but its acceptance ("${s.acceptance}") has no recorded validation`)
          // U2: publish the live plan only after a real authority version changed. No-op writes still
          // settle the activity tracker as no-progress but must not manufacture a live event.
          if (changed) {
            yield* events
              .publish(PlanEvent.Updated, {
                sessionID: SessionID.make(ctx.sessionID),
                plan_id: plan.plan_id,
                plan_version: version,
                goal: plan.goal,
                assumptions: [...plan.assumptions],
                active_step_id: plan.active_step_id,
                steps: plan.steps.map((s) => ({
                  step_id: s.step_id,
                  title: s.title,
                  status: s.status,
                  acceptance: s.acceptance ?? null,
                  assigned_agent: s.assigned_agent ?? null,
                  note: s.note ?? null,
                  evidence: [...(s.evidence ?? [])],
                })),
                done,
                total,
                changes: changeLines,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("plan.updated publication failed; snapshot remains authoritative").pipe(
                    Effect.annotateLogs({ sessionID: ctx.sessionID, plan_id: plan.plan_id, plan_version: version, cause }),
                    Effect.asVoid,
                  ),
                ),
              )
          }

          const lines = plan.steps.map((s) => {
            const mark =
              s.status === "done"
                ? "x"
                : s.status === "cancelled"
                  ? "-"
                  : s.status === "blocked"
                    ? "!"
                    : s.status === "active"
                      ? ">"
                      : " "
            const suffix = s.status === "blocked" && s.note ? ` — blocked: ${s.note}` : ""
            return `[${mark}] ${s.title}${suffix}`
          })
          const changeSummary = changeLines.length > 0 ? `\n\nChanges: ${changeLines.join("; ")}` : ""
          const warnSummary =
            acceptanceWarnings.length > 0 ? `\n\n⚠ ${acceptanceWarnings.join("; ")}. Verify before finalizing.` : ""
          // The model never has to infer the next write's parameters from prose: every successful
          // commit returns the exact model-facing fields for the following advance call.
          const nextWrite = `\n\nNext write (copy verbatim for advance):\n${JSON.stringify(retryBase(plan, version), null, 2)}`
          return {
            title: `Plan: ${done}/${total} steps`,
            output: `Goal: ${plan.goal}\n${lines.join("\n")}${changeSummary}${warnSummary}${nextWrite}`,
            metadata: {
              plan_id: plan.plan_id,
              goal: plan.goal,
              done,
              total,
              plan_protocol: changed ? "success" : "no_progress",
              plan_progress:
                changed &&
                (prior == null ||
                  AgentGateway.DeepAgentPlanController.planProgressFingerprint(prior) !==
                    AgentGateway.DeepAgentPlanController.planProgressFingerprint(plan)),
              plan_version: version,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
