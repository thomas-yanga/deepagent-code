import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806060000_session_mutation_epoch",
  up(tx) {
    // Column guards via pragma table_info keep the migration safe to re-apply (ledger seeding on
    // legacy databases can re-run it against installs that already carry some of these columns).
    const hasColumn = Effect.fn("hasColumn")(function* (table: string, column: string) {
      return (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`${table}\`)`)).some(
        (info) => info.name === column,
      )
    })
    return Effect.gen(function* () {
      if (!(yield* hasColumn("session", "mutation_epoch")))
        yield* tx.run("ALTER TABLE session ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0")
      if (!(yield* hasColumn("session_intent", "mutation_epoch")))
        yield* tx.run("ALTER TABLE session_intent ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0")
      if (!(yield* hasColumn("session_steer", "mutation_epoch")))
        yield* tx.run("ALTER TABLE session_steer ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0")
      if (!(yield* hasColumn("session_steer", "superseded_at")))
        yield* tx.run("ALTER TABLE session_steer ADD COLUMN superseded_at INTEGER")
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS session_steer_session_epoch_pending_idx
        ON session_steer (session_id, mutation_epoch, delivery, consumed_seq, superseded_at, seq)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
