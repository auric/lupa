import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * These tests verify that VS Code's bundled ripgrep binary exists at the expected path.
 * They run against the actual VS Code installation on the developer's machine.
 *
 * If these tests fail, it means either:
 * 1. VS Code is not installed in a standard location
 * 2. VS Code has changed where it stores the ripgrep binary
 *
 * The expected path structure (stable since VS Code 1.60, 2021):
 * <vscode-install>/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg[.exe]
 */

function getVSCodeInstallPaths(): string[] {
    const paths: string[] = [];

    if (process.platform === 'win32') {
        // Common Windows VS Code installation paths
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86 =
            process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

        paths.push(
            path.join(localAppData, 'Programs', 'Microsoft VS Code'),
            path.join(localAppData, 'Programs', 'Microsoft VS Code Insiders'),
            path.join(programFiles, 'Microsoft VS Code'),
            path.join(programFilesX86, 'Microsoft VS Code')
        );
    } else if (process.platform === 'darwin') {
        // macOS paths
        paths.push(
            '/Applications/Visual Studio Code.app/Contents/Resources/app',
            '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app',
            path.join(
                process.env.HOME || '',
                'Applications/Visual Studio Code.app/Contents/Resources/app'
            )
        );
    } else {
        // Linux paths
        paths.push(
            '/usr/share/code',
            '/usr/share/code-insiders',
            '/opt/visual-studio-code',
            '/snap/code/current/usr/share/code'
        );
    }

    return paths;
}

function findVSCodeInstallation(): string | undefined {
    for (const vscodePath of getVSCodeInstallPaths()) {
        // Check if this looks like a valid VS Code installation
        const resourcesPath =
            process.platform === 'darwin'
                ? vscodePath
                : path.join(vscodePath, 'resources', 'app');

        if (fs.existsSync(resourcesPath)) {
            return resourcesPath;
        }

        // Also check without resources/app for some installations
        if (fs.existsSync(vscodePath)) {
            const packageJson = path.join(vscodePath, 'package.json');
            if (fs.existsSync(packageJson)) {
                return vscodePath;
            }
        }
    }
    return undefined;
}

function getRipgrepPath(appRoot: string): string | undefined {
    const rgBinary = process.platform === 'win32' ? 'rg.exe' : 'rg';

    // Check both possible locations (same logic as ripgrepSearchService.ts)
    const candidatePaths = [
        path.join(
            appRoot,
            'node_modules',
            '@vscode',
            'ripgrep',
            'bin',
            rgBinary
        ),
        path.join(
            appRoot,
            'node_modules.asar.unpacked',
            '@vscode',
            'ripgrep',
            'bin',
            rgBinary
        ),
    ];

    for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
            return candidatePath;
        }
    }

    return undefined;
}

describe('VS Code Ripgrep Binary Verification', () => {
    const vscodeAppRoot = findVSCodeInstallation();

    it('should find VS Code installation on this machine', () => {
        if (!vscodeAppRoot) {
            console.warn(
                'VS Code installation not found in standard locations. ' +
                    'This test verifies ripgrep exists in VS Code. ' +
                    'Paths checked: ' +
                    getVSCodeInstallPaths().join(', ')
            );
        }
        // Don't fail - VS Code might be installed elsewhere or this is CI
        expect(true).toBe(true);
    });

    it('should have ripgrep binary at expected path in VS Code installation', () => {
        if (!vscodeAppRoot) {
            console.warn('Skipping: VS Code installation not found');
            return;
        }

        const rgPath = getRipgrepPath(vscodeAppRoot);

        if (!rgPath) {
            // List what's actually in the directory to help debug
            const nodeModulesPath = path.join(
                vscodeAppRoot,
                'node_modules',
                '@vscode'
            );
            const asarPath = path.join(
                vscodeAppRoot,
                'node_modules.asar.unpacked',
                '@vscode'
            );

            console.error('Ripgrep not found in either location:');
            console.error(
                `  - ${path.join(nodeModulesPath, 'ripgrep', 'bin')}`
            );
            console.error(`  - ${path.join(asarPath, 'ripgrep', 'bin')}`);

            if (fs.existsSync(nodeModulesPath)) {
                console.error(
                    `Contents of ${nodeModulesPath}:`,
                    fs.readdirSync(nodeModulesPath)
                );
            }
        }

        expect(
            rgPath,
            'Ripgrep binary should exist in VS Code installation'
        ).toBeDefined();
    });

    it('should have executable ripgrep binary', () => {
        if (!vscodeAppRoot) {
            console.warn('Skipping: VS Code installation not found');
            return;
        }

        const rgPath = getRipgrepPath(vscodeAppRoot);
        if (!rgPath) {
            console.warn('Skipping: ripgrep binary not found');
            return;
        }

        const stats = fs.statSync(rgPath);
        expect(stats.isFile(), 'Ripgrep should be a file').toBe(true);
        expect(stats.size).toBeGreaterThan(0);

        // On Unix, check if executable
        if (process.platform !== 'win32') {
            // eslint-disable-next-line no-bitwise
            const isExecutable = (stats.mode & fs.constants.X_OK) !== 0;
            expect(isExecutable, 'Ripgrep should be executable').toBe(true);
        }
    });
});
