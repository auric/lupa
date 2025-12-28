#!/usr/bin/env node
/**
 * Extension packaging script with build profile support.
 *
 * Profiles:
 * - production (default): Strips dev commands for public release
 * - internal: Keeps all commands for testing/dogfooding
 *
 * Usage:
 *   node package-extension.js              # production profile
 *   node package-extension.js --internal   # internal profile
 *
 * Flow:
 * 1. Parse profile from CLI args
 * 2. Run `npm run package` with BUILD_PROFILE env var
 * 3. Backup package.json
 * 4. Filter commands (production only)
 * 5. Run vsce package with SKIP_PREPUBLISH=1 (prepublish.js respects this)
 * 6. Restore original package.json (always, even on error)
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { shouldKeepCommand } = require('./build-profiles');

const ROOT = path.join(__dirname, '..');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const BACKUP_PATH = path.join(ROOT, 'package.json.backup');

function parseProfile() {
    const args = process.argv.slice(2);
    if (args.includes('--internal')) {
        return 'internal';
    }
    return 'production';
}

function filterDevCommands(pkg, profile) {
    if (profile === 'internal') {
        console.log('ℹ️  Internal profile: keeping all commands');
        return false;
    }

    let modified = false;

    if (pkg.contributes?.commands) {
        const original = pkg.contributes.commands.length;
        pkg.contributes.commands = pkg.contributes.commands.filter((cmd) =>
            shouldKeepCommand(cmd.command, profile)
        );
        if (pkg.contributes.commands.length !== original) {
            modified = true;
            console.log(
                `✓ Filtered ${original - pkg.contributes.commands.length} dev command(s)`
            );
        }
    }

    if (pkg.contributes?.keybindings) {
        const original = pkg.contributes.keybindings.length;
        pkg.contributes.keybindings = pkg.contributes.keybindings.filter((kb) =>
            shouldKeepCommand(kb.command, profile)
        );
        if (pkg.contributes.keybindings.length !== original) {
            modified = true;
            console.log(
                `✓ Filtered ${original - pkg.contributes.keybindings.length} dev keybinding(s)`
            );
        }
    }

    return modified;
}

async function main() {
    const profile = parseProfile();
    console.log(`📦 Packaging extension [${profile}]...\n`);

    // Run build with BUILD_PROFILE set to control which features are included
    console.log(`🔨 Running npm run package...\n`);
    execSync('npm run package', {
        stdio: 'inherit',
        cwd: ROOT,
        env: {
            ...process.env,
            BUILD_PROFILE: profile,
        },
    });

    fs.copyFileSync(PACKAGE_PATH, BACKUP_PATH);
    console.log('\n✓ Backed up package.json');

    try {
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf-8'));

        // Filter commands for production builds
        const wasModified = filterDevCommands(pkg, profile);

        if (wasModified) {
            fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 4) + '\n');
        }

        // Run vsce with SKIP_PREPUBLISH to avoid rebuilding (prepublish.js checks this)
        console.log('\n🔨 Running vsce package...\n');
        execSync('npx vsce package', {
            stdio: 'inherit',
            cwd: ROOT,
            env: { ...process.env, SKIP_PREPUBLISH: '1' },
        });

        console.log(`\n✅ Extension packaged successfully! [${profile}]`);
    } finally {
        if (fs.existsSync(BACKUP_PATH)) {
            fs.copyFileSync(BACKUP_PATH, PACKAGE_PATH);
            fs.unlinkSync(BACKUP_PATH);
            console.log('✓ Restored original package.json');
        }
    }
}

main().catch((err) => {
    console.error('❌ Packaging failed:', err.message);
    process.exit(1);
});
