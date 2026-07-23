# Contributing

Bug reports and pull requests are welcome.

## Before filing

- Search existing issues.
- Reproduce against the default branch.
- Remove credentials, vault content, transcripts, and local agent instructions.
- Use synthetic fixtures for logs and provider protocol output.

## Development

Use Node.js version from `.node-version`.

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

Tests mirror `src/` under `tests/unit/` and `tests/integration/`. New behavior and bug fixes require a failing test first, followed by the narrowest implementation change.

Provider behavior is not interchangeable. Keep provider-neutral contracts in `src/core/`, provider-owned protocol and settings behavior in `src/providers/<provider>/`, and chat orchestration in `src/features/chat/`.

## Pull requests

- Keep changes focused.
- Explain user impact and provider-specific behavior.
- Add tests and update every supported locale for new user-facing text.
- Do not add production dependencies without explaining need, license, bundle impact, and alternatives.
- Do not commit `.codian/`, `.claudian/`, `.claude/`, `.codex/`, `.context/`, vault content, credentials, or transcripts.

By contributing, you agree that your contribution is licensed under this repository's MIT License.
