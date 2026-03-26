# Lupa - GitHub Copilot Instructions

VS Code extension for PR analysis using GitHub Copilot.

> **Agent behavior & workflow**: See [CLAUDE.md](../CLAUDE.md) — the primary instructions file, shared with Claude Code.
> **Architecture & conventions**: See [ARCHITECTURE.md](../ARCHITECTURE.md) for detailed technical reference.

## Environment

- **Terminal note:** This project uses PowerShell on Windows
- **Test output**: Massive—read only last ~50 lines for summary

## Quick Reference

```bash
npm run check-types    # Fast validation (~2s)
npm run build          # Full build (~30s)
npm run test           # All tests (massive output, read last ~50 lines)
npm run package        # Production build
```
