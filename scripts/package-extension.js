#!/usr/bin/env node
/**
 * Extension packaging script with manifest filtering.
 *
 * This script wraps `vsce package` to filter dev-only commands from package.json
 * without permanently modifying the source file.
 *
 * Flow:
 * 1. Backup package.json
 * 2. Filter dev commands (toolTesting, testWebview)
 * 3. Run vsce package
 * 4. Restore original package.json (always, even on error)
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const BACKUP_PATH = path.join(ROOT, 'package.json.backup');

const DEV_COMMAND_PATTERNS = ['tooltesting', 'testwebview'];

function filterDevCommands(pkg) {
    let modified = false;

    if (pkg.contributes?.commands) {
        const original = pkg.contributes.commands.length;
        pkg.contributes.commands = pkg.contributes.commands.filter(cmd => {
            const command = cmd.command.toLowerCase();
            return !DEV_COMMAND_PATTERNS.some(pattern => command.includes(pattern));
        });
        if (pkg.contributes.commands.length !== original) {
            modified = true;
            console.log(`✓ Filtered ${original - pkg.contributes.commands.length} dev command(s)`);
        }
    }

    if (pkg.contributes?.keybindings) {
        const original = pkg.contributes.keybindings.length;
        pkg.contributes.keybindings = pkg.contributes.keybindings.filter(kb => {
            const command = kb.command.toLowerCase();
            return !DEV_COMMAND_PATTERNS.some(pattern => command.includes(pattern));
        });
        if (pkg.contributes.keybindings.length !== original) {
            modified = true;
            console.log(`✓ Filtered ${original - pkg.contributes.keybindings.length} dev keybinding(s)`);
        }
    }

    return modified;
}

async function main() {
    console.log('📦 Packaging extension...\n');

    fs.copyFileSync(PACKAGE_PATH, BACKUP_PATH);
    console.log('✓ Backed up package.json');

    try {
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf-8'));
        const wasModified = filterDevCommands(pkg);

        if (wasModified) {
            fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 4) + '\n');
        }

        console.log('\n🔨 Running vsce package...\n');
        execSync('npx vsce package', {
            stdio: 'inherit',
            cwd: ROOT
        });

        console.log('\n✅ Extension packaged successfully!');
    } finally {
        if (fs.existsSync(BACKUP_PATH)) {
            fs.copyFileSync(BACKUP_PATH, PACKAGE_PATH);
            fs.unlinkSync(BACKUP_PATH);
            console.log('✓ Restored original package.json');
        }
    }
}

main().catch(err => {
    console.error('❌ Packaging failed:', err.message);
    process.exit(1);
});
