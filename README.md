# 🔍 Lupa

**Magnify your code intelligence**

[![VS Code](https://img.shields.io/badge/VS%20Code-1.107+-blue.svg)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-0.2.0-green.svg)](./CHANGELOG.md)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](./LICENSE)

> ⚠️ **Important: Read before using!**
>
> Lupa makes **many tool calls per analysis** (often 50–100+). Each tool call counts against your GitHub Copilot premium request quota. **Avoid expensive models** like Claude Opus 4.5 (3x credits) or Claude Sonnet 4.5 (1x credits) unless you have credits to spare.
>
> See [Model Selection](#model-selection) for free and low-cost alternatives.

---

## Why "Lupa"?

**Lupa** (pronounced _LOO-pah_) means "magnifying glass" in Spanish — the perfect metaphor for what this extension does. Just as a magnifying glass reveals fine details that would otherwise be missed, Lupa examines your code changes with precision and clarity, uncovering context and relationships that traditional diff viewers simply can't provide.

---

Lupa is a VS Code extension for pull request analysis using GitHub Copilot models. It uses a tool-calling architecture where the LLM dynamically requests context via LSP-based tools, enabling deep code understanding without pre-loading entire codebases.

## Features

- 🔍 **Deep Code Analysis** — LLM-driven analysis with dynamic context gathering
- 🛠️ **16 Specialized Tools** — Symbol lookup, file reading, grep search, diff access, usage finding, plan tracking, and more
- 🤖 **Recursive Language Model (RLM)** — Diff-on-demand architecture where the LLM loads context via tools instead of receiving the full diff
- 🌲 **Recursive Agent Tree** — Complex PRs decomposed into concern groups with sub-agents analyzing each independently
- 📊 **Rich Webview UI** — Interactive results with Markdown rendering and syntax highlighting
- 💬 **Chat Integration** — Native VS Code chat participant for quick analysis

## Two Ways to Use Lupa

### 1. Webview Mode

Use the command palette for comprehensive PR analysis with a dedicated webview panel:

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **`Lupa: Analyze Pull Request`**
3. View results in the interactive webview panel

### 2. Chat Participant Mode

Use the `@lupa` chat participant directly in VS Code's chat for quick inline analysis:

```
@lupa /branch      # Analyze changes on current branch vs base
@lupa /changes     # Analyze unstaged changes
```

Type `@lupa` in the chat and use one of the available slash commands. The chat interface provides a clean, conversational experience with:

- **Clickable file references** - File paths appear as links you can click to open
- **Visible subagent work** - When subagents investigate, their tool calls show with a "🔹 #N:" prefix

### Exploration Mode

You can also use `@lupa` without a slash command to ask general questions about your codebase:

```
@lupa How is authentication handled in this project?
@lupa What's the architecture of the API layer?
```

In exploration mode, Lupa uses the same tools (file reading, symbol lookup, grep search) to investigate your codebase but without PR-specific context. Subagents are enabled for complex investigations that require parallel research.

## Model Selection

Lupa works with any language model available in your VS Code Copilot installation, including models from third-party providers you've configured.

### Selecting a Model

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **`Lupa: Select Language Model`**
3. Choose from available models (vendor shown in description)

The selected model is saved in `.vscode/lupa.json` and persists across sessions.

### Default Model

Lupa uses **GPT-4.1** as the default because it's free. GPT-4.1 works reasonably well for small to medium PRs, but **struggles with large code changes** — it may fail to use tools correctly or produce incomplete analysis when there's too much context.

For larger PRs, consider using a more capable model.

### ⚠️ Premium Models Are Expensive

Lupa is heavy on tool calling (50–100+ calls per analysis is normal). Each call counts against your premium request quota.

**Cost examples for a typical analysis:**

- Claude Opus 4.5 (3x credits): 150–300 premium requests consumed
- Claude Sonnet 4.5 (1x credits): 50–100 premium requests consumed
- GPT-4.1 (free): No credits consumed

Monitor your usage in your GitHub account settings.

### 💡 Free and Low-Cost Models

Recommended for Lupa:

| Model                 | Cost  | Notes                                             |
| --------------------- | ----- | ------------------------------------------------- |
| **GPT-4.1** (default) | Free  | Works for small PRs, struggles with large changes |
| **Grok Code Fast 1**  | 0.25x | Good balance of speed and quality                 |
| **Raptor Mini**       | Free  | Good for larger PRs                               |

### 💰 Using Your Own API Key

You can configure alternative model providers in GitHub Copilot with your own API key. This bypasses credit consumption entirely. These models appear in the model picker alongside Copilot models.

> ⚠️ **Note:** Anthropic models configured via BYOK do not work with Lupa. The VS Code Language Model API doesn't support setting system prompts, which Anthropic models require. See [vscode#255286](https://github.com/microsoft/vscode/issues/255286) for details.

## Requirements

- **VS Code** 1.107 or higher
- **GitHub Copilot** extension installed and activated
- **Git repository** with changes to analyze

## Quick Start

1. Install the Lupa extension
2. Open a Git repository with uncommitted changes or a feature branch
3. Run `Lupa: Analyze Pull Request` from the command palette
4. (Optional) Select your preferred model with `Lupa: Select Language Model`

## Configuration

Settings are stored in `.vscode/lupa.json`:

```json
{
    "preferredModelIdentifier": "copilot/gpt-4.1",
    "maxIterations": 100,
    "requestTimeoutSeconds": 300,
    "maxSubagentsPerSession": 10,
    "analysisApproach": "rlm",
    "maxRecursionDepth": 2,
    "maxTotalAgents": 12,
    "logLevel": "info"
}
```

### Analysis Approach

Lupa supports two analysis strategies, controlled by the `analysisApproach` setting:

| Approach     | Description                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`rlm`**    | **(Default)** Recursive Language Model approach. The diff is NOT embedded in the prompt. Instead, the LLM uses `list_changed_files` and `get_file_diff` tools to access changes on demand. More efficient for large diffs and enables recursive decomposition. |
| **`legacy`** | Traditional approach. The full diff is embedded directly in the user prompt. Simpler but uses more context window for large diffs.                                                                                                                             |

The RLM approach is inspired by the [Recursive Language Models paper](https://arxiv.org/abs/2512.24601) — the key insight is that LLMs work better when they actively explore context on demand rather than passively receiving it all at once. This prevents "context rot" on large PRs and allows the LLM to prioritize which files to examine.

### Recursive Review Mode

When `maxRecursionDepth` is set to 1 or higher (and `analysisApproach` is `rlm`), Lupa uses recursive review mode:

1. The **root agent** scans the PR scope and decomposes it into concern groups
2. **Sub-agents** are spawned to analyze each concern group independently
3. Sub-agents at sufficient depth can spawn their own sub-agents
4. The root agent **aggregates** all findings into a unified review

This is particularly effective for large PRs with many files across different domains (e.g., API changes + frontend updates + test modifications).

> **Fallback behavior**: Recursive mode gives the LLM the _capability_ to decompose work, but decomposition is not guaranteed. If the LLM does not spawn sub-agents (e.g., for trivial PRs), the analysis proceeds as a single root-agent investigation.

### Disabling Recursive Mode

To revert to flat, single-agent analysis, set `maxRecursionDepth` to `0` in your `.vscode/lupa.json`:

```json
{
    "maxRecursionDepth": 0
}
```

To switch back to the legacy approach (full diff embedded in prompt), set:

```json
{
    "analysisApproach": "legacy"
}
```

## Documentation

For detailed documentation, see the [docs](./docs/index.md) folder:

- [Architecture](./docs/architecture.md)
- [Component Inventory](./docs/component-inventory.md)
- [Development Guide](./docs/development-guide.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

Pre-commit hooks for linting and formatting are installed automatically when you run `npm install`.

## License

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0).

Copyright © 2026 [Ihor Lifanov](https://github.com/auric)

---

<div align="center">

**Made with ❤️ by [Ihor Lifanov](https://github.com/auric)**

</div>
