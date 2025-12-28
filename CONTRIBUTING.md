# Contributing to Lupa

Thanks for your interest in contributing! This guide covers the development workflow and quality standards.

## Getting Started

```bash
# Clone and install
git clone https://github.com/auric/lupa.git
cd lupa
npm install

# Build
npm run build

# Open in VS Code and press F5 to debug
code .
```

## Git Hooks

This project uses [Husky](https://typicode.github.io/husky/) for Git hooks with [lint-staged](https://github.com/lint-staged/lint-staged) to ensure code quality.

### Pre-commit Hook

The pre-commit hook runs automatically on every commit:

1. **Full project validation**: `npm run check-types` (TypeScript + oxlint on entire codebase)
2. **Auto-formatting**: `prettier --write` formats staged files automatically

If type checking or linting fails, the commit is blocked.

### Automatic Setup

Hooks install automatically when you run `npm install` via the `prepare` script. No manual setup required.

### Manual Hook Installation

If hooks aren't working, reinstall them:

```bash
npm run prepare
```

### Bypassing Hooks (Emergency Only)

```bash
git commit --no-verify -m "emergency fix"
```

Use sparingly—CI will still catch issues.

## Development Workflow

### Before Committing

The pre-commit hook handles everything automatically, but for faster feedback:

```bash
npm run check-types    # TypeScript + linting (~2s)
```

### Code Style

| Tool     | Purpose                             |
| -------- | ----------------------------------- |
| oxlint   | Fast linting for TypeScript/JS      |
| prettier | Code formatting                     |
| tsc      | Type checking (part of check-types) |

### Fixing Lint/Format Issues

```bash
# Fix everything automatically
npm run lint:fix

# Or format specific files
npx prettier --write path/to/file.ts
```

## Pull Request Checklist

- [ ] `npm run check-types` passes
- [ ] Tests added for new functionality
- [ ] No `console.log` in extension code (use `Log` from `loggingService`)
- [ ] Tool results use `toolSuccess()`/`toolError()` helpers
- [ ] Documentation updated if needed

## Testing

```bash
npm run test           # Run all tests (large output)
npm run test:watch     # Interactive watch mode
npx vitest run <file>  # Run specific test
```

> ⚠️ `npm run test` produces massive output. Read only the last ~50 lines for the summary.

## Documentation

- [Development Guide](docs/development-guide.md) — Build, test, debug
- [Architecture](docs/architecture.md) — System design
- [CLAUDE.md](CLAUDE.md) — Complete guidelines for AI assistants

## Questions?

Open an issue for bugs, feature requests, or questions.
