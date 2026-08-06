# Changelog

## 1.2.8 — 2026-08-06

### Prompt and context safety

- Hardened prompt context encoding with safe XML attributes, CDATA content, invalid-character normalization, and backward-compatible context parsing.
- Unified editor, browser, canvas, linked-note, chat-selection, and Codex prompt context formatting.

### Models and thinking

- Added Pi `max` thinking effort support with model-aware fallback handling.
- Added opt-in Codex `ultra` reasoning effort support; existing defaults remain unchanged.
- Added title-generation language selection, including interface-language follow mode, across supported Providers.

### Tools, agents, and history

- Normalized task-management tools into stable Todo snapshots across live Claude streams and history replay.
- Improved ACP diff preservation, Pi web-tool rendering, Codex subagent lifecycle handling, Grok tool-result normalization, and provider-native diff replay.
- Restored Pi Skill command replay from persisted history.

### Chat rendering

- Coordinated streaming Markdown renders with snapshot coalescing, visibility-aware throttling, final flushes, and improved thinking-block rendering performance.

### Dependencies and security

- Updated Claude Agent SDK, MCP SDK, development tooling, and release-attestation dependencies, including security maintenance updates.

## 1.2.7 — 2026-07-30

### Kimi Code

- Fixed Kimi Code session start error caused by provider model ID prefix decoding and missing fallback on stale session load.
- Supported dynamic ACP thinking levels (`Low` / `High` / `Max`), automatically adapting the toolbar selector.
- Omitted redundant `(on)` label from the model selector when a model has a single non-configurable effort state.
- Added opt-in diagnostic logging (`.codian/kimi-diagnostics.log`) under Kimi Code settings for remote debugging.

## 1.2.6 — 2026-07-30

### Claude-compatible services

- Kept managed Claude-compatible services on persistent transport from the first turn for more reliable session behavior.
- Stop interrupted Claude turns immediately, discard late provider output, and rebuild the connection for the next message.
- Prevent Claude Code user-setting behavior flags from overriding Codian-managed third-party service configurations.
- Request thinking output from managed third-party services when the endpoint supports it.

### Claude settings and chat feedback

- Removed the redundant manual custom-model input from Claude settings; configured service models remain available in the picker.
- Replaced random waiting messages with clear model and tool progress states.
- Show a slow-service notice when a provider has not responded after 45 seconds.

## 1.2.5 — 2026-07-29

### Claude-compatible chat

- Complete first replies from compatible services, including DeepSeek, when their stream omits Claude Code's final result event.
- Start a new compatible-service conversation through a reliable first-turn path before reusing its provider session.

## 1.2.4 — 2026-07-28

### Chat layout

- Keep the provider header and chat tabs aligned to the start of the pane.
- Keep the composer fixed at the pane bottom while messages scroll independently.

## 1.2.3 — 2026-07-28

### Chat

- Select text in a completed AI reply, then copy it or add it as removable chat context for a follow-up prompt.
- Preserve selected-reply context across all built-in Providers and show compact context chips in the conversation.

## 1.2.1 — 2026-07-27

- Logo refresh.
- About copy update.

## 1.2.0 — 2026-07-27

### Claude models

- Show models configured in Claude Code settings, including global, project, and local model overrides.
- Show built-in Claude models only after native Claude authentication is confirmed.

### Codex MCP

- Read Codex MCP server definitions from `~/.codex/config.toml` and show them in Codian.
- Mark Codex MCP controls as display-only and direct server changes to `codex mcp`.

### OpenCode and agent status

- Keep OpenCode slash-command menus usable when ACP command metadata is delayed or absent.
- Show a running tool card when ACP reports an in-progress tool update before its start event.

## 1.1.4 — 2026-07-27

### Chat and commands

- Made provider slash-command menus load reliably, refresh when chat context changes, and show a retry path when discovery fails.
- Added Codex `/fast` to switch its fast-mode setting directly from chat.
- Improved provider-specific command visibility, cancellation handling, and chat-tab state persistence.

### Models, settings, and history

- Improved model, Provider settings, and command catalog refresh behavior across supported Providers.
- Preserved Claude conversation history after a Claude environment change while preventing accidental resume against the changed service.

## 1.1.3 — 2026-07-26

### Chat navigation

- Fixed conversation-dot preview cards opening at the chat-pane top. Cards now align with the dot being hovered.

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
