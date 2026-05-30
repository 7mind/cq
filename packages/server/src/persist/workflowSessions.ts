import type { Database, Statement } from "bun:sqlite";
import type { WorkflowSessionLink } from "@cq/shared";

/** SQL row shape for the workflow_session link table. */
interface WorkflowSessionSqlRow {
  goal_id: string;
  session_id: string;
  root_invocation_id: string;
}

/**
 * Store for the `workflow_session` link table (migration #8). Maps a durable
 * goal id to the workflow session + root invocation created for its `/plan`
 * run, so a resumed phase dispatch re-attaches to the SAME session instead of
 * orphaning a fresh one.
 */
export class WorkflowSessionStore {
  private readonly stmtUpsert: Statement;
  private readonly stmtGet: Statement<WorkflowSessionSqlRow, [string]>;

  constructor(db: Database) {
    this.stmtUpsert = db.prepare(`
      INSERT INTO workflow_session (goal_id, session_id, root_invocation_id)
      VALUES ($goal_id, $session_id, $root_invocation_id)
      ON CONFLICT(goal_id) DO UPDATE SET
        session_id = excluded.session_id,
        root_invocation_id = excluded.root_invocation_id
    `);
    this.stmtGet = db.prepare<WorkflowSessionSqlRow, [string]>(
      "SELECT * FROM workflow_session WHERE goal_id = ?",
    );
  }

  link(link: WorkflowSessionLink): void {
    this.stmtUpsert.run({
      $goal_id: link.goalId,
      $session_id: link.sessionId,
      $root_invocation_id: link.rootInvocationId,
    });
  }

  getByGoal(goalId: string): WorkflowSessionLink | undefined {
    const r = this.stmtGet.get(goalId);
    return r
      ? { goalId: r.goal_id, sessionId: r.session_id, rootInvocationId: r.root_invocation_id }
      : undefined;
  }
}
