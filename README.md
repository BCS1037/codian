# Codian

![Codian preview](assets/Preview.png)

Codian is a desktop-only Obsidian plugin that puts local coding agents in a sidebar and inline-edit workflow. Your vault is the working directory: agents can read and change files, search, run tools, and work across multi-step tasks.

Codian-authored source is open source under the MIT License. Codian is derived from [Claudian](https://github.com/YishenTu/claudian) and maintained by BCS. Third-party components remain governed by their own licenses and terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What it does

- Chat sidebar with tabs, saved conversations, search, resume, fork, rewind, and provider-native history where available.
- Inline editing with a word-level diff preview.
- Live Markdown composer, `@` file and folder context, drag-and-drop context, images, and Explorer **Add to Codian**.
- Slash commands, Skills, MCP, subagents, tool approval, Plan modes, and provider-specific controls.
- Six local CLI providers: Claude, Codex, OpenCode, Pi, Grok, and Kimi Code.

Provider capabilities intentionally differ. Codian exposes what the installed CLI supports; it does not replace provider subscriptions, API usage charges, login, quotas, or safety policies.

## Requirements

- Obsidian 1.11.4 or later on macOS, Linux, or Windows.
- Node.js 24 for building from source.
- One or more installed provider CLIs:
  - [Claude Code](https://code.claude.com/docs/en/overview)
  - [Codex](https://github.com/openai/codex)
  - [OpenCode](https://opencode.ai/)
  - [Pi](https://github.com/badlogic/pi-mono)
  - [Grok](https://docs.x.ai/docs/grok-code-fast-1)
  - [Kimi Code](https://moonshotai.github.io/kimi-code/)

Authentication, API keys, proxies, base URLs, and provider usage charges remain the user's responsibility. Codian's Claude integration requires explicit API-key authentication, supported cloud-provider authentication, or credentials for an Anthropic-compatible endpoint. It does not use Claude Free, Pro, or Max OAuth credentials.

## Install

Download the latest release, or build from source:

```bash
git clone https://github.com/BCS1037/codian.git
cd codian
npm ci
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/codianz/`, then enable **Codian** in Obsidian's Community plugins settings.

### Upgrade from plugin ID `codian`

Codian `1.0.1` uses the Community plugins ID `codianz` while keeping the displayed name **Codian**. On first launch, it copies legacy plugin tab state from `<vault>/.obsidian/plugins/codian/data.json` only when `codianz` has no data yet. It never deletes or overwrites legacy plugin data, and vault-level `.codian/` settings and conversation metadata remain in place.

Do not run both plugin IDs at once. After confirming the new **Codian** plugin opens normally, disable the legacy `codian` plugin.

## Safety and privacy

Codian starts local provider CLIs with your vault as their working directory. Depending on provider and permissions, a conversation can:

- read, create, modify, move, or delete vault files;
- execute local commands and tools;
- access explicitly attached files or directories outside your vault;
- use configured Skills, MCP servers, subagents, and provider services;
- send prompts, attachments, tool output, and relevant context to selected provider or MCP endpoint.

Provider CLIs execute with your operating-system user permissions and may access more than Codian's UI exposes. Only enable providers, projects, Skills, and MCP servers you trust. Review every approval request before allowing it.

Conversation metadata is stored in `<vault>/.codian/`. Providers may keep local transcripts and configuration under locations such as `.claude/`, `~/.codex/sessions/`, `~/.grok/`, or Kimi's CLI state.

Codian has no telemetry service. Network activity comes from provider CLIs, configured model services, and MCP endpoints you explicitly use.

## Development

```bash
npm ci
npm run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities through [GitHub private vulnerability reporting](SECURITY.md), not a public issue.

## License and attribution

Codian-authored and upstream-derived source is licensed under the [MIT License](LICENSE). See [NOTICE](NOTICE) for Claudian attribution and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependencies governed separately.
