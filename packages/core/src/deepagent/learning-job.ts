import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"

// BUG-004-407 §3/S3: the durable background-learning job authority on top of the `learning_job`
// table (migration 20260807140000_learning_job). Replaces the process-local LearningQueue array:
//
//  - enqueue is idempotent on `dedupe_key` (INSERT OR IGNORE): duplicate lifecycle events collapse
//    into one job per project/run/trigger boundary;
//  - claim uses a version CAS fence so two workers cannot both own a job;
//  - settle requires the claiming owner, so a stale owner can never ack another worker's job;
//  - recoverStaleLeases re-queues running jobs whose lease expired (crash recovery), while a job
//    that hit provider-started ambiguity is surfaced as `recovery_required` instead of being
//    silently replayed.
//
// The job row is only the SCHEDULING authority — candidate/document governance stays with the
// DocumentStore authority; the two are associated by `result_ref`, never by a shared transaction.

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

export type LearningTrigger = "session_finalization" | "idle" | "pause" | "project_switch"
export type LearningJobState = "pending" | "running" | "completed" | "failed" | "cancelled" | "recovery_required"

export type LearningJobRow = {
  readonly job_id: string
  readonly project_id: string | null
  readonly session_id: string | null
  readonly run_id: string | null
  readonly trigger: LearningTrigger
  readonly dedupe_key: string
  readonly state: LearningJobState
  readonly owner: string | null
  readonly lease_expires_at: number | null
  readonly version: number
  readonly result_ref: string | null
  readonly error_code: string | null
  readonly error_detail: string | null
  readonly created_at: number
  readonly updated_at: number
}

// INSERT OR IGNORE on the UNIQUE dedupe_key. Returns the job_id when a new row was enqueued, or
// null when the dedupe key already existed (the duplicate lifecycle event is silently discarded).
export const enqueue = Effect.fn("LearningJob.enqueue")(function* (
  db: Database,
  input: {
    readonly jobId: string
    readonly projectId: string | null
    readonly sessionId: string | null
    readonly runId: string | null
    readonly trigger: LearningTrigger
    readonly dedupeKey: string
  },
) {
  const rows = yield* db.all<{ job_id: string }>(sql`
    INSERT OR IGNORE INTO learning_job (job_id, project_id, session_id, run_id, trigger, dedupe_key)
    VALUES (${input.jobId}, ${input.projectId}, ${input.sessionId}, ${input.runId}, ${input.trigger}, ${input.dedupeKey})
    RETURNING job_id
  `)
  return rows[0]?.job_id ?? null
})

// CAS claim: read the oldest pending job, then fence on (job_id, state='pending', version). A
// competing worker that lost the race observes zero rows and retries the next candidate; after a
// bounded number of races the claim reports none available.
export const claim = Effect.fn("LearningJob.claim")(function* (
  db: Database,
  input: { readonly owner: string; readonly leaseMs: number; readonly now?: number },
) {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const leaseExpiresAt = now + Math.floor(input.leaseMs / 1000)
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = yield* db.get<{ job_id: string; version: number }>(sql`
      SELECT job_id, version FROM learning_job
      WHERE state = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `)
    if (!candidate) return null
    const won = yield* db.all<LearningJobRow>(sql`
      UPDATE learning_job
      SET state = 'running', owner = ${input.owner}, lease_expires_at = ${leaseExpiresAt},
          version = version + 1, updated_at = ${now}
      WHERE job_id = ${candidate.job_id} AND state = 'pending' AND version = ${candidate.version}
      RETURNING *
    `)
    if (won.length > 0) return won[0]
  }
  return null
})

// Settle a claimed job. The owner fence makes a stale owner's settle a no-op (returns false), so an
// expired worker can never ack a job that recovery already re-assigned.
export const settle = Effect.fn("LearningJob.settle")(function* (
  db: Database,
  input: {
    readonly jobId: string
    readonly owner: string
    readonly outcome: "completed" | "failed" | "cancelled"
    readonly resultRef?: string
    readonly errorCode?: string
    readonly errorDetail?: string
    readonly now?: number
  },
) {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const rows = yield* db.all<{ job_id: string }>(sql`
    UPDATE learning_job
    SET state = ${input.outcome}, owner = NULL, lease_expires_at = NULL,
        result_ref = ${input.resultRef ?? null}, error_code = ${input.errorCode ?? null},
        error_detail = ${input.errorDetail ?? null}, updated_at = ${now}
    WHERE job_id = ${input.jobId} AND owner = ${input.owner} AND state = 'running'
    RETURNING job_id
  `)
  return rows.length > 0
})

// Provider-started ambiguity: the reviewer/extraction may already have produced a side effect, so
// the job must NOT be silently re-queued — surface it as recovery_required for explicit resolution.
export const requireRecovery = Effect.fn("LearningJob.requireRecovery")(function* (
  db: Database,
  input: { readonly jobId: string; readonly owner: string; readonly errorCode?: string; readonly now?: number },
) {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const rows = yield* db.all<{ job_id: string }>(sql`
    UPDATE learning_job
    SET state = 'recovery_required', error_code = ${input.errorCode ?? null}, updated_at = ${now}
    WHERE job_id = ${input.jobId} AND owner = ${input.owner} AND state = 'running'
    RETURNING job_id
  `)
  return rows.length > 0
})

// Restart recovery: re-queue running jobs whose lease expired (owner crashed). Jobs with a live
// lease are left to expire naturally. Returns the number of re-queued jobs.
export const recoverStaleLeases = Effect.fn("LearningJob.recoverStaleLeases")(function* (
  db: Database,
  input: { readonly now?: number } = {},
) {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const rows = yield* db.all<{ job_id: string }>(sql`
    UPDATE learning_job
    SET state = 'pending', owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ${now}
    WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ${now}
    RETURNING job_id
  `)
  return rows.length
})

export const get = Effect.fn("LearningJob.get")(function* (db: Database, jobId: string) {
  return (yield* db.get<LearningJobRow>(sql`SELECT * FROM learning_job WHERE job_id = ${jobId}`)) ?? null
})
