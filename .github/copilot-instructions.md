# Lupa - GitHub Copilot Instructions

VS Code extension for PR analysis using GitHub Copilot.

> **Full documentation**: See [CLAUDE.md](../CLAUDE.md) for complete architecture, conventions, and development guidelines. This file contains only Copilot-specific overrides.

## Project Summary

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Build**: Vite (dual: Node.js extension + browser webview)
- **Tests**: Vitest with VS Code mocks
- **UI**: React 19, shadcn/ui, Tailwind CSS v4

## Environment

- **Terminal**: PowerShell on Windows
- **Test output**: Massive—read only last ~50 lines for summary

## Quick Reference

```bash
npm run check-types    # Fast validation (~2s)
npm run build          # Full build (~30s)
npm run test           # All tests (massive output, read last ~50 lines)
npm run package        # Production build
```

## Code Style

- Use `Log` from `loggingService.ts`, not `console.log`
- Use `toolSuccess()`/`toolError()` for tool return values
- Prefer `param: string | undefined` over `param?: string`
- New tools: extend `BaseTool`, define Zod schema, register in `ServiceManager`

## Quality Standards

- Production-ready TypeScript: DRY, SOLID, properly typed
- Comments only when logic is non-trivial or intent is unclear
- No magic numbers—use named constants
- No empty catch blocks—always handle errors
- Verify changes compile before suggesting

## Patterns to Avoid

- Over-abstraction for hypothetical future requirements
- Excessive defensive programming
- Copy-paste code instead of proper abstractions
- Comments explaining obvious code

## Skills

When the user asks you to use a specific skill, you **must** use it. Skills are `SKILL.md` files located in:

- `.claude/skills/` subfolders
- `.github/skills/` subfolders

Read the skill file first, then follow its instructions for the task at hand.
