# Lupa

**Intelligent Pull Request Analysis for VS Code using GitHub Copilot**

[![VS Code](https://img.shields.io/badge/VS%20Code-1.107+-blue.svg)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-0.1.6-green.svg)](./CHANGELOG.md)

> ⚠️ **Credits Warning**: Lupa uses AI models that may consume your GitHub Copilot premium requests. See [Model Selection](#model-selection) for free alternatives.

Lupa is a VS Code extension that performs comprehensive pull request analysis using GitHub Copilot models. It uses a tool-calling architecture where the LLM dynamically requests context via LSP-based tools, enabling deep code understanding without pre-loading entire codebases.

## Features

- 🔍 **Deep Code Analysis** - LLM-driven analysis with dynamic context gathering
- 🛠️ **14 Specialized Tools** - Symbol lookup, file reading, grep search, usage finding, plan tracking, and more
- 🤖 **Subagent Delegation** - Complex investigations handled by autonomous sub-agents
- 📊 **Rich Webview UI** - Interactive results with Markdown rendering and syntax highlighting
- 💬 **Chat Integration** - Native VS Code chat participant for quick analysis

## Two Ways to Use Lupa

### 1. Webview Mode (Full Analysis)

Use the command palette for comprehensive PR analysis with a dedicated webview panel:

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **`Lupa: Analyze Pull Request`**
3. View results in the interactive webview panel

### 2. Chat Participant Mode (Quick Analysis)

Use the `@lupa` chat participant directly in VS Code's chat for quick inline analysis:

```
@lupa /branch      # Analyze changes on current branch vs base
@lupa /changes     # Analyze unstaged changes
```

Type `@lupa` in the chat and use one of the available slash commands.

## Model Selection

Lupa works with any language model available in your VS Code Copilot installation.

### Selecting a Model

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **`Lupa: Select Language Model`**
3. Choose from available models

The selected model is saved in `.vscode/lupa.json` and persists across sessions.

### Default Model

Lupa uses **GPT-4.1** as the default because it's free. However, **GPT-4.1 performs poorly with tool calling**—it often fails to use tools.

### ⚠️ Important: Premium Models Are Expensive

> **Premium models consume your GitHub Copilot premium requests!**
>
> Lupa is heavy on tool calling, which means each analysis may use many premium requests. Avoid models with 1x or 3x credit multipliers (like Claude Opus 4.5) unless you have credits to spare. Monitor your usage in your GitHub account settings.

### 💡 Free and Low-Cost Models

The following models are recommended for Lupa:

- **GPT-4.1** (default) - Free, but poor at tool calling
- **Grok Code Fast 1** - Free, reasonable quality (recommended)
- **Raptor Mini** - Free alternative
- **Claude Haiku 3.5** - 0.33x credits, good quality

### 💰 Using Your Own API Key

You can configure alternative model providers in GitHub Copilot with your own API key to avoid credit consumption.

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
    "preferredModelVersion": "gpt-4.1",
    "maxIterations": 100,
    "requestTimeoutSeconds": 300,
    "maxSubagentsPerSession": 10,
    "logLevel": "info"
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

See [LICENSE](./LICENSE) for details.

---

**Built with ❤️ for developers who care about code quality**
