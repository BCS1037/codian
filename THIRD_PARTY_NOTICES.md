# Third-party notices

Codian source is distributed under AGPL-3.0, except for third-party components governed by their own licenses and terms.

## Claude Agent SDK

Codian depends on `@anthropic-ai/claude-agent-sdk` to integrate Claude.

- Copyright: Anthropic PBC. All rights reserved.
- Package license: `SEE LICENSE IN README.md` / `SEE LICENSE IN LICENSE.md`.
- Terms: [https://code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)
- SDK repository: [https://github.com/anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
- Platform packages: `@anthropic-ai/claude-agent-sdk-darwin-arm64`, `@anthropic-ai/claude-agent-sdk-darwin-x64`, `@anthropic-ai/claude-agent-sdk-linux-arm64`, `@anthropic-ai/claude-agent-sdk-linux-arm64-musl`, `@anthropic-ai/claude-agent-sdk-linux-x64`, `@anthropic-ai/claude-agent-sdk-linux-x64-musl`, `@anthropic-ai/claude-agent-sdk-win32-arm64`, and `@anthropic-ai/claude-agent-sdk-win32-x64`.

The Claude Agent SDK is not relicensed under Codian's AGPL-3.0 License. Use of the SDK is subject to Anthropic's applicable legal agreements. Before publishing binary artifacts, maintainers must confirm that the planned SDK version and distribution method permit redistribution and must include all required notices.

## Other direct runtime dependencies

| Package                       | License      |
| ----------------------------- | ------------ |
| `@codemirror/commands`      | MIT          |
| `@codemirror/state`         | MIT          |
| `@codemirror/view`          | MIT          |
| `@modelcontextprotocol/sdk` | MIT          |
| `smol-toml`                 | BSD-3-Clause |
| `tslib`                     | 0BSD         |

`package-lock.json` is the authoritative dependency snapshot. Transitive dependencies retain their own notices and license terms. Binary release preparation must generate and review a complete production dependency license inventory.

## thinking-orbs

Portions of `src/features/chat/ui/WelcomeOrb.ts` are adapted from [thinking-orbs](https://github.com/Jakubantalik/thinking-orbs), Copyright (c) 2026 Jakub Antalik, licensed under the MIT License.

MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
