# Lupa - Project Overview

> **A VS Code extension for comprehensive pull request analysis using GitHub Copilot models.**

## Quick Reference

| Property             | Value                      |
| -------------------- | -------------------------- |
| **Project Name**     | Lupa                       |
| **Version**          | 0.1.11                     |
| **Publisher**        | auric                      |
| **Repository Type**  | Monolith                   |
| **Primary Language** | TypeScript                 |
| **Framework**        | VS Code Extension API      |
| **UI Framework**     | React 19 + Tailwind CSS v4 |
| **Build Tool**       | Vite 7.x                   |
| **Test Framework**   | Vitest 4.x                 |
| **VS Code Minimum**  | 1.107.0                    |
| **Node.js Minimum**  | ≥20                        |

## Purpose

Lupa provides **AI-powered code review** directly within VS Code using GitHub Copilot models. Unlike traditional static analysis, Lupa uses a **tool-calling architecture** that allows the LLM to dynamically explore the codebase to understand context, find related code, and provide deep, contextual feedback.

## Key Features

### 🔍 PR Analysis

- Analyze branch changes against default branch
- Analyze uncommitted changes
- Comprehensive security, performance, and maintainability review

### 🛠️ Tool-Calling Architecture

- LLM dynamically requests context via tools
- Finds symbol definitions, usages, and file content
- Supports subagent delegation for complex investigations

### 💬 Chat Integration

- `@lupa` chat participant for Copilot Chat
- `/branch` command - analyze current branch
- `/changes` command - analyze uncommitted changes
- Follow-up questions and exploration mode

### 📊 Rich Webview UI

- Markdown rendering with syntax highlighting
- Diff visualization
- Tool execution history and debugging

## Architecture Summary

```
Coordinators → Services → Models → Tools
      │             │         │        │
      ▼             ▼         ▼        ▼
 Orchestration  Business   LLM     Codebase
               Logic     Interface  Access
```

### Layer Overview

| Layer        | Path                | Purpose                             |
| ------------ | ------------------- | ----------------------------------- |
| Coordinators | `src/coordinators/` | High-level orchestration            |
| Services     | `src/services/`     | Core business logic                 |
| Models       | `src/models/`       | LLM interface, conversation, tokens |
| Tools        | `src/tools/`        | LLM-callable tools with Zod schemas |
| Prompts      | `src/prompts/`      | System prompt generators            |
| Webview      | `src/webview/`      | React UI (browser context)          |

## Technology Stack

### Core

| Technology            | Purpose                    |
| --------------------- | -------------------------- |
| TypeScript 5.9        | Type-safe development      |
| VS Code Extension API | Extension platform         |
| GitHub Copilot API    | LLM access via `vscode.lm` |

### UI

| Technology      | Purpose               |
| --------------- | --------------------- |
| React 19        | Webview components    |
| React Compiler  | Automatic memoization |
| shadcn/ui       | Component primitives  |
| Radix UI        | Accessible primitives |
| Tailwind CSS v4 | Utility-first styling |

### Build & Test

| Technology      | Purpose                     |
| --------------- | --------------------------- |
| Vite            | Dual build (Node + browser) |
| Vitest          | Unit testing                |
| Testing Library | React component testing     |

### Utilities

| Technology | Purpose                                    |
| ---------- | ------------------------------------------ |
| Zod        | Schema validation + JSON Schema generation |
| fdir       | Fast file discovery                        |
| ignore     | Gitignore processing                       |

## Key Commands

| Command                       | Description                  |
| ----------------------------- | ---------------------------- |
| `Lupa: Analyze Pull Request`  | Start PR analysis workflow   |
| `Lupa: Select Language Model` | Choose Copilot model         |
| `Lupa: Select Git Repository` | Choose repository to analyze |
| `Lupa: Reset Analysis Limits` | Reset settings to defaults   |

## Entry Points

| File                                          | Purpose            |
| --------------------------------------------- | ------------------ |
| `src/extension.ts`                            | VS Code activation |
| `src/services/prAnalysisCoordinator.ts`       | Main coordinator   |
| `src/services/serviceManager.ts`              | DI container       |
| `src/services/toolCallingAnalysisProvider.ts` | Analysis engine    |
| `src/webview/main.tsx`                        | Webview entry      |

## Related Documentation

- [Architecture](architecture.md) - Detailed architecture documentation
- [Development Guide](development-guide.md) - Build, test, and contribute
- [Source Tree Analysis](source-tree-analysis.md) - Directory structure
- [Component Inventory](component-inventory.md) - All components listed
- [CLAUDE.md](../CLAUDE.md) - Complete development guidelines
