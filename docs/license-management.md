# License Management Guide

This document describes how to manage and track third-party dependency licenses in the Lupa project.

## Quick Commands

```bash
npm run licenses:generate    # Generate THIRD_PARTY_LICENSES.md
npm run licenses:check       # Show license summary for review
```

## Tools Comparison

| Tool                | Maintained | Best For                 | Formats                   |
| ------------------- | ---------- | ------------------------ | ------------------------- |
| **license-report**  | ✅ Active  | Documentation generation | JSON, CSV, Markdown, HTML |
| **license-checker** | ❌ 7 years | CI validation            | JSON, CSV                 |
| **legally**         | ❌ 5 years | Quick visual inspection  | Terminal                  |
| **nlf**             | ❌ 7 years | Tree visualization       | CSV                       |

## Recommended Setup

### Installation

```bash
npm install --save-dev license-report license-checker
```

### Package.json Scripts

```json
{
  "scripts": {
    "licenses:generate": "license-report --output=markdown > THIRD_PARTY_LICENSES.md",
    "licenses:check": "license-checker --summary"
  }
}
```

> **Note:** This project has all dependencies in `devDependencies` (bundled for distribution), so we don't use `--only=prod` or `--production` flags.

> **Note:** The `--onlyAllow` flag in license-checker has known issues with semicolon-separated lists on Windows. Use `--summary` for manual review instead.

## Why Two Tools?

1. **license-report** (documentation)

   - Actively maintained
   - Native Markdown output
   - Multiple formats for different needs
   - Configurable field selection

2. **license-checker** (validation)
   - `--summary` for quick license overview
   - `--json` for detailed license data
   - Wide ecosystem adoption (438K weekly downloads)
   - Note: `--onlyAllow` flag has cross-platform issues

## CI Integration

For CI validation, use the summary output and review manually:

```yaml
- name: Check Licenses
  run: npm run licenses:check
```

For stricter enforcement, consider using a config-file-based tool like `license-checker-webpack-plugin` or `license-webpack-plugin`.

## Licenses Found in This Project

Current license breakdown (run `npm run licenses:check` to verify):

- **MIT**: 589 packages
- **ISC**: 49 packages
- **BSD-3-Clause**: 15 packages
- **BSD-2-Clause**: 15 packages
- **Apache-2.0**: 12 packages
- **BlueOak-1.0.0**: 9 packages (rimraf and related)
- **Artistic-2.0**: 5 packages
- **CC0-1.0**: 3 packages
- **MIT-0**: 2 packages
- **MPL-2.0**: 2 packages
- Other permissive: WTFPL, Python-2.0, CC-BY-4.0, 0BSD

All licenses are permissive and compatible with AGPL-3.0.

### Copyleft Considerations

If you need to avoid copyleft licenses (which may require source disclosure), add to `--failOn`:

- GPL-2.0
- GPL-3.0
- AGPL-3.0
- LGPL-2.1
- LGPL-3.0

## Generating Documentation

### Markdown (for THIRD_PARTY_LICENSES.md)

```bash
npx license-report --output=markdown > THIRD_PARTY_LICENSES.md
```

### JSON (for programmatic use)

```bash
npx license-report --output=json > licenses.json
```

### Custom Fields

```bash
npx license-report --output=markdown \
  --fields=name \
  --fields=installedVersion \
  --fields=licenseType \
  --fields=link \
  --fields=author \
  --fields=licensePeriod
```

## VS Code Extensions

| Extension               | Purpose                                |
| ----------------------- | -------------------------------------- |
| **Choose a License**    | Add LICENSE file to project            |
| **licenser**            | Insert license headers in source files |
| **psioniq File Header** | Auto-insert file headers               |

Note: CLI tools are the standard for dependency license aggregation.

## Best Practices

1. **Include only production dependencies** in shipped documentation
2. **Regenerate on dependency changes** - add to pre-commit or CI
3. **Use Markdown format** for human readability
4. **Validate in CI** to catch license issues early
5. **Document license decisions** when adding new dependencies

## Example Output

Running `npm run licenses:generate` produces:

```markdown
| name  | installedVersion | licenseType | link                              | author   |
| ----- | ---------------- | ----------- | --------------------------------- | -------- |
| react | 19.0.0           | MIT         | https://github.com/facebook/react | Facebook |
| vite  | 7.0.0            | MIT         | https://github.com/vitejs/vite    | Evan You |

...
```

## References

- [license-report npm](https://www.npmjs.com/package/license-report)
- [license-checker npm](https://www.npmjs.com/package/license-checker)
- [SPDX License List](https://spdx.org/licenses/)
