# Versioning and releases

HiveForge follows Semantic Versioning while the public API and operational contracts mature. The current line is V0.1 MVP and is not a production-readiness claim.

## Development prereleases

Development releases use an annotated, monotonic tag:

```text
v0.1.0-alpha.1
v0.1.0-alpha.2
```

The next number is calculated from local and `origin` tags. A prerelease tag must point to the exact published commit and be created only after the configured validation commands pass. Stable `v0.1.0` must not be created automatically.

## Bootstrap and normal flow

The one-time bootstrap of the approved empty repository may publish directly to `main`. After bootstrap, normal work uses `work/<work-order-id>-<short-slug>`, a pull request, CI, review, and an explicit merge decision.

The Windows-first finalizer in `scripts/finalize-execution.ps1` makes the sequence repeatable. Its dry-run mode performs discovery and validation without mutating GitHub or Git state.

## Release notes

Every release updates `CHANGELOG.md` or records the relevant entry and includes validation results, the commit SHA, known limitations, and security/data handling notes when applicable. Releases remain GitHub prereleases until a separate decision authorizes a stable release.

## Rollback

Rollback is performed by reverting through a reviewed pull request or by explicitly documenting a release correction. Do not rewrite published history or move a tag silently.
