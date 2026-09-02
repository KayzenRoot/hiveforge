# HiveForge V0.1 setup

## Requirements

- Node.js 22 or newer. Node 26 is supported and provides the built-in `node:sqlite` runtime used by this MVP.
- Git on `PATH`.
- Codex CLI on `PATH` for real runs. The dashboard still boots when Codex is absent and reports `NOT_CONFIGURED`.

## Local run

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. Register an existing local Git repository. The default database is `data/hiveforge.sqlite`; set `HIVEFORGE_DB_PATH` to override it.

Start the separate mailbox worker in another terminal:

```powershell
npm run worker
```

The worker watches each registered project's `reviewMailboxPath` and reconciles the registry every five seconds, so projects registered after worker startup are picked up without a restart. Only top-level `.json` files are consumed. Processed files move to `.processed`; invalid files move to `.rejected`.

## Validation commands

```powershell
npm test
npm run test:e2e
npm run lint
npm run typecheck
npm run build
```

## Review contract

See `docs/RCP-EXAMPLE.json`. The canonical contract uses `schema_version`, `review_id`, `project_id`, `work_order_id`, `base_sha`, `head_sha`, `verdict`, `progress_percent`, `summary`, `findings`, `next_action`, `executor_prompt` and `checkpoint_note`. A full Git SHA is required; `work_order_id` uniquely resolves the run. Evidence Lock also requires clean working-tree evidence.

Validation runs the configured project `testCommand` and any configured optional lint, typecheck and build commands after every terminal Codex turn. Each result is persisted in SQLite with command, timestamps, exit code, stdout, stderr and `PASS`, `FAIL`, `NOT_CONFIGURED` or `ERROR`.

## Environment notes

No secret, cookie or raw authentication token is stored by HiveForge. The Codex adapter uses the installed official App Server lifecycle and asks `account/read` with `refreshToken: false`; it does not call the legacy `getAuthStatus` method.
