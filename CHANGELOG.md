# Changelog

## 1.1.2 — 2026-07-26

### Marketplace compliance

- Removed the redundant platform name from plugin and marketplace descriptions to satisfy Community Plugins manifest validation.
- Replaced the altered root license text with the complete canonical GNU AGPL-3.0 text and added a verification guard so repository license detection cannot regress.

## 1.1.1 — 2026-07-26

### Polish and marketplace metadata

- Aligned every About-page section, heading, paragraph, and sponsorship link with the slogan card's left edge.
- Rewrote Codian's public description around its multi-provider agent workspace and updated the Community Plugins listing copy.
- Made the English README the primary project entry point, moved Simplified Chinese documentation to `README_ZH.md`, and retained a compatibility redirect at `README_EN.md`.
- Restored the canonical AGPL-3.0 license file header so GitHub and Obsidian Community Plugins can recognize the repository license; upstream Claudian MIT attribution remains in `NOTICE`.

## 1.1.0 — 2026-07-26

### Chat experience

- Added a compact conversation-dot navigator. It previews each prompt and reply, jumps directly to the prompt, highlights the latest turn with the Obsidian accent color, and leaves clear space for message content.
- Added a General-setting switch between conversation-dot navigation and the original navigation buttons.
- Added the MIT-licensed thinking-orbs `solving` animation to every empty chat tab, with reduced-motion and light/dark-theme support.

### Models and providers

- Unified chat model menus by provider. Claude's configured and third-party models now appear together; unconfigured fallback Claude candidates stay hidden.
- Moved supported model effort choices into the model submenu and display the active effort beside the selected model.
- Added explicit Claude model management with aliases, plus a DeepSeek preset for Anthropic-compatible Claude Code connections.

### Workspace and settings

- Added shared Skill discovery for vault `.agents/skills` entries, including managed symlinks, and show the Providers that support each shared Skill.
- Removed duplicated Workspace resource headings and descriptions.
- Added an About tab with Codian's slogan, feedback guidance, and an Afdian sponsorship link for 维客.

## 1.0.2 — 2026-07-23

- Updated `bun.lock` dependency lockfile for Obsidian Community Store automated review compatibility.

## 1.0.1 — 2026-07-23

- Changed the Obsidian plugin ID from `codian` to `codianz` for Community plugins directory compatibility. The displayed plugin name remains Codian.
- Migrates legacy `.obsidian/plugins/codian/data.json` into an empty `codianz` data store without deleting or overwriting old data.
- Keeps vault-level `.codian/` settings and conversation metadata unchanged.

## 1.0.0 — 2026-07-23

First public source version of Codian.

### Included

- Local coding-agent sidebar and inline-edit workflows for Obsidian.
- Claude, Codex, OpenCode, Pi, Grok, and Kimi provider integrations.
- Conversation history, resume, fork, rewind, search, and multi-tab workflows.
- Skills, slash commands, MCP, subagents, tool approval, and Plan modes.
- MIT-licensed Codian source with retained Claudian attribution.
