# Codian

[English](README.md) | [简体中文](README_ZH.md)

[![Release](https://img.shields.io/github/v/release/BCS1037/codian)](https://github.com/BCS1037/codian/releases)
[![License](https://img.shields.io/github/license/BCS1037/codian)](LICENSE)
[![Obsidian Version](https://img.shields.io/badge/Obsidian-v1.11.4%2B-purple)](https://obsidian.md)

![Codian preview](assets/Preview.png)

**Codian** 是一款仅支持桌面端的 Obsidian 插件，将本地 AI 编码 Agent 无缝嵌入到侧边栏对话与嵌入式（Inline-Edit）编辑工作流中。你的 Obsidian Vault 即为 Agent 的工作目录（`pwd`）：Agent 可以读取和修改笔记文件、执行全文检索、调用本地命令行工具，并在保护笔记库环境的前提下完成多步骤复杂任务。

Codian 衍生自开源项目 [Claudian](https://github.com/YishenTu/claudian)，由 BCS 基于 MIT 协议开源与维护。

---

## ✨ 特性亮点

- 💬 **侧边栏 Chat 终端**：支持多 Tab 标签页、会话自动保存、快速历史搜索、会话恢复/Fork/Rewind 以及 Provider 原生历史回放。
- ✏️ **嵌入式编辑器 (Inline Edit)**：在编辑器中选中文本直接输入指令，实时查看词级 Diff 预览并一键应用修改。
- 📝 **Live Markdown 实时预览输入框**：基于 CodeMirror 6 构建，支持 `@笔记` 和 `@文件夹` 自动补全、拖拽 Vault 文件/目录添加上下文、图片粘贴，以及文件列表右键“添加到 Codian”。
- 🌐 **第三方 Claude 服务 Profile**：内置中科院云、阿里百炼 (Bailian)、火山引擎 (Volcengine Ark) 等服务预设，支持自定义 Anthropic 兼容 Endpoint。API Key 通过 Obsidian 原生 `SecretStorage` 安全加密存储。
- ⚙️ **丰富的 Agent 生态支持**：原生支持 6 大本地 CLI Provider（`claude`, `codex`, `kimi`, `grok`, `opencode`, `pi`），完整支持 Agent Skills、MCP 服务器、Subagents 协同、工具执行审批流以及 Plan / Thinking 思考模式。
- 🛡️ **安全与隐私保障**：直接调用本地安装的 Provider CLI 运行，不包含任何第三方遥测（Telemetry）或数据收集服务。

---

## 📦 环境要求

- **Obsidian**：桌面端 Version 1.11.4 或更高版本（支持 macOS, Linux, Windows）。
- **Provider CLI**：本地系统中已安装并在 `$PATH` 中可用的 Provider CLI：
  - [Claude Code](https://code.claude.com/docs/en/overview) (`claude`)
  - [Codex](https://github.com/openai/codex) (`codex`)
  - [Kimi Code](https://moonshotai.github.io/kimi-code/) (`kimi`)
  - [Grok](https://docs.x.ai/docs/grok-code-fast-1) (`grok`)
  - [OpenCode](https://opencode.ai/) (`opencode`)
  - [Pi](https://github.com/badlogic/pi-mono) (`pi`)
- **Node.js**：Node.js 24（仅从源码编译时需要）。

---

## 🚀 快速安装

### 方式一：Obsidian 社区插件市场（推荐）
1. 打开 Obsidian **设置** -> **社区插件**。
2. 搜索 **Codian**（插件 ID 为 `codianz`）。
3. 点击 **安装** 并 **启用**。

### 方式二：手动 Release 安装（预构建产物）
1. 前往最新 [GitHub Release 页面](https://github.com/BCS1037/codian/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 打开 Vault 的插件目录：`<vault>/.obsidian/plugins/codianz/`（如 `codianz` 文件夹不存在请手动新建）。
3. 将下载的 3 个文件复制到该目录下。
4. 重新加载 Obsidian 或在社区插件设置中启用 **Codian**。

### 方式三：源码编译安装（开发者）
```bash
git clone https://github.com/BCS1037/codian.git
cd codian
npm ci
npm run build
```
编译完成后，将生成的 `main.js`、`manifest.json` 与 `styles.css` 复制到 Vault 的 `.obsidian/plugins/codianz/` 目录中。

---

## ⚙️ 配置与第三方 Endpoint

在 Obsidian 设置中的 **Codian** 选项卡可以进行 Provider 独立配置：

- **第三方 Claude Profiles**：在 Claude 选项卡中，可直接添加中科院云、阿里百炼、火山引擎等 Anthropic 兼容 Endpoint。
- **SecretStorage 密钥安全**：所有的 API Key 与 Token 均存储于 Obsidian 原生 `SecretStorage` 中，不会明文保存在插件配置文件中。
- **提供商连接与路径**：可在 **设置** -> **提供商** -> 选择对应的 Provider -> **连接** 选项卡中，配置 CLI 可执行文件路径或独立环境变量。

---

## ❓ 常见问题排查 (FAQ)

### 1. 提示 "CLI not detected" 无法找到本地 CLI 命令？
macOS 图形界面应用（通过 Finder 或 Dock 启动）默认不会加载终端 Shell（如 `~/.zshrc` 或 `~/.bash_profile`）中设置的环境变量。
- **解决方法**：前往 Codian **设置** -> **提供商** -> 选择对应的 Provider（如 Claude、Codex、Kimi 等）-> 在 **连接** 选项卡下的 **CLI 路径** 中，直接填入该 CLI 在你本机上的绝对路径（例如 `/usr/local/bin/claude` 或 `/opt/homebrew/bin/codex`）。

### 2. Kimi Code CLI 提示初始化错误？
Kimi Code CLI 在使用前需要在终端完成首次认证。
- **解决方法**：打开终端运行 `kimi` 命令，按照提示完成登录与模型配置。配置完成后，Codian 即可正常识别并开启 ACP 会话。

### 3. 为什么插件文件夹是 `codianz`，但在 Obsidian 里显示叫 `Codian`？
`codianz` 是提交给 Obsidian 社区插件市场的内部唯一标识（Plugin ID），而 **Codian** 是在界面上呈现给用户的显示名称。安装时请务必保证插件文件夹名称为 `codianz`。

---

## 🛠️ 本地开发与代码验证

```bash
# 安装依赖
npm ci

# 执行类型检查、代码 Lint 与单元测试
npm run verify

# 运行依赖许可证与代码安全扫描
npm run security:audit
```

在提交 Pull Request 之前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞请参照 [SECURITY.md](SECURITY.md) 进行私密通报。

---

## 📄 许可证与开源致谢

Codian 源码及上游衍生代码遵循 [MIT 许可证](LICENSE)。
上游 Claudian 声明参见 [NOTICE](NOTICE)，第三方组件声明参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
