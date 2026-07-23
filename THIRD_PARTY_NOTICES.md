# Third-party notices

Codian source is distributed under the MIT License, except for third-party components governed by their own licenses and terms.

## Claude Agent SDK

Codian depends on `@anthropic-ai/claude-agent-sdk` to integrate Claude.

- Copyright: Anthropic PBC. All rights reserved.
- Package license: `SEE LICENSE IN README.md` / `SEE LICENSE IN LICENSE.md`.
- Terms: <https://code.claude.com/docs/en/legal-and-compliance>
- SDK repository: <https://github.com/anthropics/claude-agent-sdk-typescript>
- Platform packages: `@anthropic-ai/claude-agent-sdk-darwin-arm64`, `@anthropic-ai/claude-agent-sdk-darwin-x64`, `@anthropic-ai/claude-agent-sdk-linux-arm64`, `@anthropic-ai/claude-agent-sdk-linux-arm64-musl`, `@anthropic-ai/claude-agent-sdk-linux-x64`, `@anthropic-ai/claude-agent-sdk-linux-x64-musl`, `@anthropic-ai/claude-agent-sdk-win32-arm64`, and `@anthropic-ai/claude-agent-sdk-win32-x64`.

The Claude Agent SDK is not relicensed under Codian's MIT License. Use of the SDK is subject to Anthropic's applicable legal agreements. Before publishing binary artifacts, maintainers must confirm that the planned SDK version and distribution method permit redistribution and must include all required notices.

## Other direct runtime dependencies

| Package | License |
| --- | --- |
| `@codemirror/commands` | MIT |
| `@codemirror/state` | MIT |
| `@codemirror/view` | MIT |
| `@modelcontextprotocol/sdk` | MIT |
| `smol-toml` | BSD-3-Clause |
| `tslib` | 0BSD |

`package-lock.json` is the authoritative dependency snapshot. Transitive dependencies retain their own notices and license terms. Binary release preparation must generate and review a complete production dependency license inventory.
