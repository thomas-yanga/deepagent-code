import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// BUG-004-407: durable background-learning job authority. Replaces the process-local LearningQueue
// array: a job row is the scheduling authority; workers claim with a version CAS + lease, and
// restart recovery re-queues stale leases. `dedupe_key UNIQUE` collapses duplicate lifecycle events
// (idle / pause / project_switch / session_finalization) into one job per project/run boundary.
export default {
  id: "20260807140000_learning_job",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE learning_job (
          job_id           TEXT    NOT NULL PRIMARY KEY,
          project_id       TEXT,
          session_id       TEXT,
          run_id           TEXT,
          trigger          TEXT    NOT NULL
            CHECK (trigger IN (
              'session_finalization','idle','pause','project_switch'
            )),
          dedupe_key       TEXT    NOT NULL UNIQUE,
          state            TEXT    NOT NULL DEFAULT 'pending'
            CHECK (state IN ('pending','running','completed','failed','cancelled','recovery_required')),
          owner            TEXT,
          lease_expires_at INTEGER,
          version          INTEGER NOT NULL DEFAULT 0,
          result_ref       TEXT,
          error_code       TEXT,
          error_detail     TEXT,
          created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      yield* tx.run(`
        CREATE INDEX learning_job_state_created
          ON learning_job (state, created_at)
      `)
      yield* tx.run(`
        CREATE INDEX learning_job_owner_lease
          ON learning_job (owner, lease_expires_at)
          WHERE owner IS NOT NULL
      `)
      yield* tx.run(`
        CREATE INDEX learning_job_project_created
          ON learning_job (project_id, created_at)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
