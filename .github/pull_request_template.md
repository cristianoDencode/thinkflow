## What and why

<!-- What does this change do, and why? Link the issue it closes (Closes #123). -->

## How to test

<!-- Commands or steps a reviewer can follow. -->

## Checklist

- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm depcruise` and `pnpm test` pass
- [ ] Tests added or updated (and `pnpm e2e` run if end-to-end flows are affected)
- [ ] Docs updated (`docs/`, `.env.example`) and a line added to `CHANGELOG.md` under "Unreleased"
- [ ] No secrets, real personal data or client-specific names in code, tests, fixtures or screenshots
- [ ] The layering rules still hold (see [CONTRIBUTING.md](../CONTRIBUTING.md))
- [ ] Commit messages follow `Type(scope): summary`
