# Codex App Server integration

The correction increment was verified against the installed `codex-cli 0.152.0`.

Regenerate the official protocol artifacts locally with:

```powershell
.\scripts\verify-codex-protocol.ps1
```

The adapter uses the official stdio lifecycle:

- launch: `codex app-server` (stdio is the default);
- initialization: `initialize`, `initialized`;
- authentication/account: `account/read` with `refreshToken: false`;
- thread: `thread/start` with `cwd` and `ephemeral`;
- turn: `turn/start` with `threadId`, `input` and `cwd`;
- terminal event: `turn/completed`, mapped only when the returned turn status is `completed`, `failed` or `interrupted`.

No legacy `getAuthStatus` call, undocumented project field or raw authentication token is used. Every returned turn ID is persisted before the run can advance, and a missing ID blocks the dispatch.

The real smoke command is:

```powershell
npx tsx scripts/codex-smoke.ts
```

It uses a temporary Git repository and asks Codex to reply without modifying files.
