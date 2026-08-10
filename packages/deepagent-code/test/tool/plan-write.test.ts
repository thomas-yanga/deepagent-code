import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  buildPlanFromWriteInput,
  createPlanDoc,
  PlanConflictError,
  PlanValidationError,
  type PlanDoc,
} from "@deepagent-code/core/deepagent/plan-controller"
import { normalizeModelPlanWrite, PlanWriteParameters } from "../../src/tool/plan-write"

// BUG-006-407 regression oracle: the model-facing `advance` is a server-merged status patch. The
// incident payload that triggered "Plan protocol violation budget exhausted" in production (Kimi K3,
// ses_01dbe3ae5fffwDJA0wrp2kSQBv) restated titles/acceptance while only intending a status change;
// the strict full-document contract rejected it as unsafe_step_identity. These tests pin the merged
// boundary so that shape can no longer be misclassified as an identity mutation.

const SESSION = "ses_plan_write_test"

const authority = (): PlanDoc =>
  createPlanDoc(
    SESSION,
    "ship the migration safely",
    [
      {
        step_id: "s1",
        title: "Write the schema migration",
        status: "done" as const,
        acceptance: "migration applies on an empty database",
        assigned_agent: "db-specialist",
        evidence: ["run:r1"],
      },
      {
        step_id: "s2",
        title: "Backfill historical rows",
        status: "active" as const,
        acceptance: "row counts match before/after",
        assigned_agent: null,
      },
      {
        step_id: "s3",
        title: "Replay the incident session",
        status: "pending" as const,
        acceptance: "advance commits without identity rejection",
        assigned_agent: null,
      },
    ],
    ["sqlite wal enabled", "no concurrent writer"],
  )

const REF = { plan_id: "", doc_id: "doc:plan:x", version: 2 }
const refFor = (doc: PlanDoc) => ({ ...REF, plan_id: doc.plan_id })

describe("normalizeModelPlanWrite (BUG-006-407 server-side merge)", () => {
  test("incident-shaped payload: identity restatements ignored, only status/active change", () => {
    const previous = authority()
    const merged = normalizeModelPlanWrite({
      params: {
        operation: "advance",
        expected_plan_id: previous.plan_id,
        expected_version: 2,
        // The model restates (and mangles) server-owned identity — every one of these is ignored.
        goal: "shortened goal text",
        assumptions: ["wrong assumption"],
        steps: [
          {
            step_id: "s1",
            title: "shortened title",
            status: "done",
            acceptance: "paraphrased acceptance",
            assigned_agent: "someone-else",
          },
          { step_id: "s2", title: "Backfill historical rows", status: "done" },
          { step_id: "s3", title: "Replay the incident session", status: "active" },
        ],
        active_step_id: "s3",
      },
      previous,
      ref: refFor(previous),
    })

    const built = buildPlanFromWriteInput(SESSION, merged, previous, refFor(previous))
    expect(built.plan_id).toBe(previous.plan_id)
    expect(built.goal).toBe(previous.goal)
    expect(built.assumptions).toEqual(previous.assumptions)
    expect(built.steps.map((s) => s.title)).toEqual(previous.steps.map((s) => s.title))
    expect(built.steps.map((s) => s.acceptance)).toEqual(previous.steps.map((s) => s.acceptance))
    expect(built.steps.map((s) => s.assigned_agent)).toEqual(previous.steps.map((s) => s.assigned_agent))
    expect(built.steps.map((s) => s.status)).toEqual(["done", "done", "active"])
    expect(built.active_step_id).toBe("s3")
    // evidence stays runtime-owned and is carried over from the matching prior step
    expect(built.steps[0]?.evidence).toEqual(["run:r1"])
  })

  test("partial patch: steps absent from the patch are preserved unchanged", () => {
    const previous = authority()
    const merged = normalizeModelPlanWrite({
      params: {
        operation: "advance",
        expected_plan_id: previous.plan_id,
        expected_version: 2,
        steps: [
          { step_id: "s2", status: "done" },
          { step_id: "s3", status: "active" },
        ],
        active_step_id: "s3",
      },
      previous,
      ref: refFor(previous),
    })
    expect(merged.steps).toHaveLength(3)
    expect(merged.steps.map((s) => s.status)).toEqual(["done", "done", "active"])
    const built = buildPlanFromWriteInput(SESSION, merged, previous, refFor(previous))
    expect(built.steps[0]?.status).toBe("done")
    expect(built.active_step_id).toBe("s3")
  })

  test("omitted active_step_id retains; explicit null clears", () => {
    const previous = authority()
    const retained = normalizeModelPlanWrite({
      params: {
        operation: "advance",
        expected_plan_id: previous.plan_id,
        expected_version: 2,
        steps: [{ step_id: "s2", status: "done" }],
      },
      previous,
      ref: refFor(previous),
    })
    expect(retained.active_step_id).toBe(previous.active_step_id)

    const cleared = normalizeModelPlanWrite({
      params: {
        operation: "advance",
        expected_plan_id: previous.plan_id,
        expected_version: 2,
        steps: [{ step_id: "s2", status: "done" }],
        active_step_id: null,
      },
      previous,
      ref: refFor(previous),
    })
    expect(cleared.active_step_id).toBeNull()
  })

  test("unknown step id is deterministically rejected with offending ids", () => {
    const previous = authority()
    try {
      normalizeModelPlanWrite({
        params: {
          operation: "advance",
          expected_plan_id: previous.plan_id,
          expected_version: 2,
          steps: [{ step_id: "sX", status: "done" }],
        },
        previous,
        ref: refFor(previous),
      })
      expect.unreachable("must throw")
    } catch (error) {
      if (!(error instanceof PlanValidationError)) throw error
      expect(error.code).toBe("unsafe_step_identity")
      expect(error.offending_step_ids).toEqual(["sX"])
    }
  })

  test("duplicate step id is deterministically rejected with duplicate ids", () => {
    const previous = authority()
    try {
      normalizeModelPlanWrite({
        params: {
          operation: "advance",
          expected_plan_id: previous.plan_id,
          expected_version: 2,
          steps: [
            { step_id: "s1", status: "done" },
            { step_id: "s1", status: "active" },
          ],
        },
        previous,
        ref: refFor(previous),
      })
      expect.unreachable("must throw")
    } catch (error) {
      if (!(error instanceof PlanValidationError)) throw error
      expect(error.code).toBe("duplicate_step_id")
      expect(error.offending_step_ids).toEqual(["s1"])
    }
  })

  test("stale precondition wins over step-identity checks (typed conflict first)", () => {
    const previous = authority()
    try {
      normalizeModelPlanWrite({
        params: {
          operation: "advance",
          expected_plan_id: previous.plan_id,
          expected_version: 1, // authority already moved on (e.g. concurrent replan)
          steps: [{ step_id: "s1", status: "done" }],
        },
        previous,
        ref: refFor(previous),
      })
      expect.unreachable("must throw")
    } catch (error) {
      if (!(error instanceof PlanConflictError)) throw error
      expect(error.actual?.plan_id).toBe(previous.plan_id)
      expect(error.actual?.version).toBe(2)
    }
  })

  test("advance without an authority falls through to the strict plan_missing contract", () => {
    const merged = normalizeModelPlanWrite({
      params: {
        operation: "advance",
        expected_plan_id: "plan_missing",
        expected_version: 1,
        steps: [{ step_id: "s1", status: "done" }],
      },
      previous: null,
      ref: null,
    })
    expect(() => buildPlanFromWriteInput(SESSION, merged, null, null)).toThrow(PlanValidationError)
    try {
      buildPlanFromWriteInput(SESSION, merged, null, null)
    } catch (error) {
      if (!(error instanceof PlanValidationError)) throw error
      expect(error.code).toBe("plan_missing")
    }
  })

  test("create stays a strict full structural write (missing goal rejected)", () => {
    const merged = normalizeModelPlanWrite({
      params: {
        operation: "create",
        expected_plan_id: null,
        expected_version: null,
        steps: [{ title: "do the thing", status: "pending" }],
      },
      previous: null,
      ref: null,
    })
    try {
      buildPlanFromWriteInput(SESSION, merged, null, null)
      expect.unreachable("must throw")
    } catch (error) {
      if (!(error instanceof PlanValidationError)) throw error
      expect(error.code).toBe("empty_goal")
    }
  })
})

describe("plan wire schema (BUG-006-407 patch contract)", () => {
  const decode = Schema.decodeUnknownSync(PlanWriteParameters)

  test("status-only advance payload decodes without goal/titles", () => {
    const decoded = decode({
      operation: "advance",
      expected_plan_id: "plan_x",
      expected_version: 2,
      steps: [{ step_id: "s1", status: "done" }],
    })
    expect(decoded.operation).toBe("advance")
    expect(decoded.active_step_id).toBeUndefined()
  })

  test("the authoritative retry base re-decodes as a valid advance payload", () => {
    // The exact shape the tool returns as "Authoritative retry base" must round-trip through the
    // provider-facing schema when the caller adds operation, so a model can copy it verbatim.
    const base = {
      expected_plan_id: "plan_x",
      expected_version: 3,
      active_step_id: "s2",
      steps: [
        { step_id: "s1", status: "done" },
        { step_id: "s2", status: "blocked", note: "waiting on review" },
        { step_id: "s3", status: "pending" },
      ],
    }
    const decoded = decode({ operation: "advance", ...base })
    expect(decoded.steps[1]?.note).toBe("waiting on review")
  })

  test("create still requires the operation envelope", () => {
    expect(() => decode({ goal: "x", steps: [] })).toThrow()
  })
})
