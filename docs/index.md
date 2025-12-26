# Lupa Documentation Index

> **🔍 Lupa** - VS Code extension for comprehensive pull request analysis using GitHub Copilot models.

---

## Project Overview

| Property             | Value                        |
| -------------------- | ---------------------------- |
| **Type**             | VS Code Extension (Monolith) |
| **Primary Language** | TypeScript                   |
| **Framework**        | VS Code Extension API        |
| **UI**               | React 19 + Tailwind CSS v4   |
| **Architecture**     | Tool-Calling LLM Pattern     |

---

## Quick Reference

### Tech Stack

- **Runtime**: Node.js ≥20, VS Code ≥1.107.0
- **Build**: Vite 7.x (dual: Node.js + browser)
- **Test**: Vitest 4.x with VS Code mocks
- **UI**: React 19 + shadcn/ui + Radix

### Key Entry Points

| File                                          | Purpose              |
| --------------------------------------------- | -------------------- |
| `src/extension.ts`                            | Extension activation |
| `src/services/serviceManager.ts`              | DI container         |
| `src/services/toolCallingAnalysisProvider.ts` | Analysis engine      |
| `src/webview/main.tsx`                        | Webview entry        |

### Commands

```bash
npm run check-types    # Fast type check (~2s)
npm run build          # Full build (~30s)
npm run test           # All tests
npm run package        # Production build
```

---

## Generated Documentation

### Core Documentation

- [Project Overview](project-overview.md) - Purpose, features, and quick reference
- [Architecture](architecture.md) - System design, layers, and patterns
- [Source Tree Analysis](source-tree-analysis.md) - Annotated directory structure
- [Component Inventory](component-inventory.md) - All components, services, and tools
- [Development Guide](development-guide.md) - Build, test, and contribute

### Additional References

- [CLAUDE.md](../CLAUDE.md) - Complete development guidelines and agent behavior

---

## Existing Documentation

- [.github/copilot-instructions.md](../.github/copilot-instructions.md) - Copilot workspace instructions

### Research Notes

- [docs/research/vscode-copilot-chat-research.md](research/vscode-copilot-chat-research.md) - Copilot Chat API research
- [docs/research/vscode-lm-tool-calling-api.md](research/vscode-lm-tool-calling-api.md) - Tool calling API research
- [docs/research/vscode-chat-participant-api.md](research/vscode-chat-participant-api.md) - Chat participant API
- [docs/research/vscode-chat-response-streaming.md](research/vscode-chat-response-streaming.md) - Response streaming
- [docs/research/context-window-management.md](research/context-window-management.md) - Context management

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────┐
│                     Coordinators                         │
│  PRAnalysisCoordinator → AnalysisOrchestrator           │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                       Services                           │
│  ServiceManager → ToolCallingAnalysisProvider           │
│  ChatParticipantService → GitOperationsManager          │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                        Models                            │
│  ConversationRunner → ToolExecutor → ToolRegistry       │
│  CopilotModelManager → TokenValidator                   │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                        Tools                             │
│  FindSymbol │ ReadFile │ SearchPattern │ RunSubagent    │
└─────────────────────────────────────────────────────────┘
```

---

## Getting Started

### For Development

1. Clone: `git clone https://github.com/auric/lupa.git`
2. Install: `npm install`
3. Build: `npm run build`
4. Debug: Press `F5` in VS Code

### For Usage

1. Install Lupa extension
2. Ensure GitHub Copilot is installed and authenticated
3. Use `@lupa /branch` in Copilot Chat to analyze branch
4. Or run `Lupa: Analyze Pull Request` command

---

## Key Patterns

### Tool-Calling Architecture

LLM dynamically requests context via tools instead of loading entire codebase:

```
LLM: "I see validateUser() in the diff, let me understand it"
  ↓
Tool: find_symbol(name_path: "validateUser", include_body: true)
  ↓
LLM: "Now I can see the implementation and provide feedback"
```

### Service Initialization (3 Phases)

```
Phase 1: Foundation (no dependencies)
  → WorkspaceSettings, Logging, StatusBar, Git, UI

Phase 2: Core (depend on foundation)
  → CopilotModelManager, PromptGenerator, SymbolExtractor

Phase 3: High-Level (depend on core)
  → ToolRegistry, ToolExecutor, ConversationManager, Analysis
```

### Tool Result Pattern

```typescript
// Always use helpers for consistent results
return toolSuccess(data); // Success with data
return toolError(message); // Failure with message
```

---

## Documentation Generation

This documentation was generated using the BMAD document-project workflow:

- **Mode**: Exhaustive scan
- **Generated**: December 26, 2025
- **Files Analyzed**: 80+ source files
- **State File**: [project-scan-report.json](project-scan-report.json)

---

## Navigation

| If you want to...      | Go to...                                      |
| ---------------------- | --------------------------------------------- |
| Understand the project | [Project Overview](project-overview.md)       |
| Learn the architecture | [Architecture](architecture.md)               |
| Explore the codebase   | [Source Tree](source-tree-analysis.md)        |
| Find a component       | [Component Inventory](component-inventory.md) |
| Start contributing     | [Development Guide](development-guide.md)     |
| Read full guidelines   | [CLAUDE.md](../CLAUDE.md)                     |
