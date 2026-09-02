export const migrations: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        local_path TEXT NOT NULL,
        remote_url TEXT,
        default_branch TEXT NOT NULL,
        working_branch TEXT NOT NULL,
        test_command TEXT NOT NULL,
        lint_command TEXT,
        typecheck_command TEXT,
        build_command TEXT,
        autonomy_mode TEXT NOT NULL CHECK (autonomy_mode IN ('AUTONOMOUS', 'GUARDED', 'CONTROLLED')),
        review_mailbox_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        work_order_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        autonomy_mode TEXT NOT NULL,
        max_iterations INTEGER NOT NULL DEFAULT 12,
        max_correction_cycles INTEGER NOT NULL DEFAULT 4,
        repeated_finding_threshold INTEGER NOT NULL DEFAULT 3,
        iteration_count INTEGER NOT NULL DEFAULT 0,
        correction_cycles INTEGER NOT NULL DEFAULT 0,
        repeated_findings_json TEXT NOT NULL DEFAULT '{}',
        current_prompt TEXT,
        expected_base_sha TEXT,
        expected_head_sha TEXT,
        last_review_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL,
        state TEXT,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at);
      CREATE TABLE IF NOT EXISTS codex_threads (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS git_evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        diff_summary TEXT NOT NULL DEFAULT '',
        captured_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        project_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        action TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        UNIQUE(run_id, id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL UNIQUE REFERENCES reviews(id),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        requested_at TEXT NOT NULL,
        approved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        review_id TEXT,
        dispatch_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        UNIQUE(run_id, dispatch_key)
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS mailbox_events (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  }
];
