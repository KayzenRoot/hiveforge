# Contributing to HiveForge

Thanks for contributing. HiveForge is an active local-first MVP, so keep changes small, observable, and easy to review.

## Before you change code

1. Read the relevant documentation and state-machine contracts.
2. Create a branch named `work/<work-order-id>-<short-slug>` from `main` for normal work.
3. Keep product changes separate from governance or tooling changes when practical.

## Development loop

Install dependencies with `npm ci`, then run the full validation set before opening a pull request:

```powershell
npm test
npm run test:e2e
npm run lint
npm run typecheck
npm run build
```

Add or update tests for behavior changes. Do not commit files under `review/`, local databases, credentials, or generated build output.

## Commits and pull requests

Use Conventional Commits, for example `feat: add run pause control` or `fix: reject stale review head`. Pull requests should explain the intent, validation performed, and any remaining risks. The pull request template is part of the required review record.

The one-time empty-repository bootstrap may publish directly to `main` under the approved work order. All later changes use a branch and pull request.

## Release discipline

Development releases use monotonic tags such as `v0.1.0-alpha.1`. Stable `v0.1.0` is not implied by the MVP and must not be created without an explicit release decision.
