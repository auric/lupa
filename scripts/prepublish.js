#!/usr/bin/env node
/**
 * Prepublish wrapper script for vsce package/publish.
 *
 * When called directly by vsce (normal flow), runs `npm run package`.
 * When SKIP_PREPUBLISH is set (by package-extension.js), skips the build.
 */

const { execSync } = require('child_process');

if (process.env.SKIP_PREPUBLISH) {
    console.log('⏭️  Skipping prepublish (already built with correct profile)');
    process.exit(0);
}

console.log('🔨 Running prepublish build...');
execSync('npm run package', {
    stdio: 'inherit',
    cwd: process.cwd(),
});
