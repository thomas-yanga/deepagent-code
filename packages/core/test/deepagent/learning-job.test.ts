import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import learningJobMigration from "@deepagent-code/core/database/migration/20260807140000_learning_job"
import * as LearningJob from "../../src/deepagent/learning-job"

// BUG-004-407 (L-D01..L-D05, L-D18): the durable learning_job authority — idempotent enqueue on
// dedupe_key, single-winner CAS claim, owner-fenced settle, stale-lease recovery, and explicit
// recovery_required for provider-started ambiguity (never an automatic replay).

const run = <A, E>(effect: Effect.Effect<A, E, import("effect/unstable/sql/SqlClient").SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const withDb = <A>(f: (db: EffectDrizzleSqlite.EffectSQLiteDatabase) => Effect.Effect<A, unknown>) =>
  run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.applyOnly(db, [learningJobMigration])
      return yield* f(db)
    }),
  )

const job = (id: string, key = id) => ({
  jobId: id,
  projectId: "projA",
  sessionId: "sess1",
  runId: "run1",
  trigger: "idle" as const,
  dedupeKey: key,
})

describe("LearningJob durable queue (BUG-004-407)", () => {
  test("enqueue is idempotent on dedupe_key (L-D02)", async () => {
    await withDb(
      Effect.fnUntraced(function* (db) {
        expect(yield* LearningJob.enqueue(db, job("job-1", "idle:projA:run1"))).toBe("job-1")
        // a duplicate lifecycle event with the same dedupe key is silently discarded
        expect(yield* LearningJob.enqueue(db, job("job-2", "idle:projA:run1"))).toBeNull()
        expect(yield* LearningJob.enqueue(db, job("job-1", "idle:projA:run1"))).toBeNull()
        const count = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM learning_job`)
        expect(count?.count).toBe(1)
      }),
    )
  })

  test("claim is single-winner CAS; the loser sees no job (L-D05)", async () => {
    await withDb(
      Effect.fnUntraced(function* (db) {
        yield* LearningJob.enqueue(db, job("job-1"))
        const first = yield* LearningJob.claim(db, { owner: "worker-a", leaseMs: 30_000 })
        expect(first?.job_id).toBe("job-1")
        expect(first?.owner).toBe("worker-a")
        // the same pending job is no longer claimable — a second worker gets nothing
        expect(yield* LearningJob.claim(db, { owner: "worker-b", leaseMs: 30_000 })).toBeNull()
      }),
    )
  })

  test("settle is owner-fenced: a stale owner cannot ack another worker's job", async () => {
    await withDb(
      Effect.fnUntraced(function* (db) {
        yield* LearningJob.enqueue(db, job("job-1"))
        yield* LearningJob.claim(db, { owner: "worker-a", leaseMs: 30_000 })
        expect(yield* LearningJob.settle(db, { jobId: "job-1", owner: "worker-b", outcome: "completed" })).toBe(false)
        expect((yield* LearningJob.get(db, "job-1"))?.state).toBe("running")
        expect(yield* LearningJob.settle(db, { jobId: "job-1", owner: "worker-a", outcome: "completed" })).toBe(true)
        expect((yield* LearningJob.get(db, "job-1"))?.state).toBe("completed")
      }),
    )
  })

  test("expired leases are re-queued on recovery; live leases are left alone (L-D04)", async () => {
    await withDb(
      Effect.fnUntraced(function* (db) {
        yield* LearningJob.enqueue(db, job("job-stale"))
        yield* LearningJob.enqueue(db, job("job-live"))
        yield* LearningJob.claim(db, { owner: "dead-worker", leaseMs: 1_000, now: 100 })
        yield* LearningJob.claim(db, { owner: "live-worker", leaseMs: 60_000, now: 100 })
        // job-stale has the earlier created_at so it is claimed first (lease expires at 101)
        const recovered = yield* LearningJob.recoverStaleLeases(db, { now: 130 })
        expect(recovered).toBe(1)
        expect((yield* LearningJob.get(db, "job-stale"))?.state).toBe("pending")
        expect((yield* LearningJob.get(db, "job-stale"))?.owner).toBeNull()
        expect((yield* LearningJob.get(db, "job-live"))?.state).toBe("running")
        // a fresh worker can now claim the recovered job and finish it
        const claimed = yield* LearningJob.claim(db, { owner: "new-worker", leaseMs: 30_000 })
        expect(claimed?.job_id).toBe("job-stale")
        expect(yield* LearningJob.settle(db, { jobId: "job-stale", owner: "new-worker", outcome: "completed" })).toBe(true)
      }),
    )
  })

  test("provider-started ambiguity becomes recovery_required and is never auto-requeued (L-D18)", async () => {
    await withDb(
      Effect.fnUntraced(function* (db) {
        yield* LearningJob.enqueue(db, job("job-1"))
        yield* LearningJob.claim(db, { owner: "worker-a", leaseMs: 1_000, now: 100 })
        expect(yield* LearningJob.requireRecovery(db, { jobId: "job-1", owner: "worker-a" })).toBe(true)
        expect((yield* LearningJob.get(db, "job-1"))?.state).toBe("recovery_required")
        // lease recovery must NOT silently requeue a recovery_required job
        expect(yield* LearningJob.recoverStaleLeases(db, { now: 10_000 })).toBe(0)
        expect(yield* LearningJob.claim(db, { owner: "worker-b", leaseMs: 30_000 })).toBeNull()
        expect((yield* LearningJob.get(db, "job-1"))?.state).toBe("recovery_required")
      }),
    )
  })
})
