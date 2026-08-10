import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// BUG-002-407 / BUG-004-407: immutable released-retrieval-snapshot authority. `active` doc status
// only means approved-for-evaluation; production retrieval (Run B) may consume exactly the most
// recent snapshot whose verdict is 'passed'. doc_refs is a JSON array of
// { doc_id, version, doc_type, fingerprint }; parent_snapshot_id keeps lineage for rollback
// analysis. Snapshot rows are append-only: a failed release never mutates or deletes doc versions.
export default {
  id: "20260808010000_released_snapshot",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE released_snapshot (
          snapshot_id         TEXT    NOT NULL PRIMARY KEY,
          parent_snapshot_id  TEXT    REFERENCES released_snapshot(snapshot_id),
          project_id          TEXT    NOT NULL,
          scope               TEXT    NOT NULL DEFAULT 'project',
          doc_refs            TEXT    NOT NULL,
          verdict             TEXT    NOT NULL CHECK(verdict IN ('passed','failed','pending')),
          evaluation_matrix_ref TEXT,
          created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
          finalized_at        INTEGER
        )
      `)
      yield* tx.run(`
        CREATE INDEX released_snapshot_project_verdict_idx
        ON released_snapshot (project_id, verdict, created_at DESC)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
