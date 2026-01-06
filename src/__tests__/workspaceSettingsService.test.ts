import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';

vi.mock('fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
}));

vi.mock('vscode', async (importOriginal) => {
    const actual = await importOriginal<typeof vscode>();
    return {
        ...actual,
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
            onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
            // Default file watcher mock - tests can override for simulation
            createFileSystemWatcher: vi.fn(() => ({
                onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
                onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
                onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
                dispose: vi.fn(),
            })),
        },
    };
});

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

describe('WorkspaceSettingsService', () => {
    let service: WorkspaceSettingsService;
    let mockContext: vscode.ExtensionContext;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        mockContext = {
            globalStorageUri: { fsPath: '/global/storage' },
        } as unknown as vscode.ExtensionContext;

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('{}');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('WORKSPACE_ROOT_MARKER functionality', () => {
        describe('setSelectedRepositoryPath', () => {
            it('should not persist when repo path matches workspace root (default behavior)', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test/workspace');
                vi.advanceTimersByTime(600); // Trigger debounced save

                // No file written - workspace root is the default, no need to persist
                expect(fs.writeFileSync).not.toHaveBeenCalled();
                // File should be deleted if it existed (empty userSettings)
                expect(fs.unlinkSync).toHaveBeenCalled();
            });

            it('should not persist when paths differ only in trailing slash', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test/workspace/');
                vi.advanceTimersByTime(600);

                // Normalized to workspace root - not persisted
                expect(fs.writeFileSync).not.toHaveBeenCalled();
            });

            it('should not persist when paths differ only in backslash vs forward slash', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: 'C:\\test\\workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('C:/test/workspace');
                vi.advanceTimersByTime(600);

                // Normalized to workspace root - not persisted
                expect(fs.writeFileSync).not.toHaveBeenCalled();
            });

            it('should not persist when paths differ in double slashes', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test//workspace');
                vi.advanceTimersByTime(600);

                // Normalized to workspace root - not persisted
                expect(fs.writeFileSync).not.toHaveBeenCalled();
            });

            it('should store absolute path when repo path differs from workspace root', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/other/repo');
                vi.advanceTimersByTime(600);

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining(
                        '"selectedRepositoryPath": "/other/repo"'
                    ),
                    'utf-8'
                );
            });

            it('should delete key when called with undefined (not write undefined)', () => {
                // First set a value so the file exists
                vi.mocked(fs.existsSync).mockReturnValue(true);
                vi.mocked(fs.readFileSync).mockReturnValue(
                    JSON.stringify({ selectedRepositoryPath: '/some/path' })
                );
                service = new WorkspaceSettingsService(mockContext);

                // Now clear it
                service.setSelectedRepositoryPath(undefined);
                vi.advanceTimersByTime(600);

                // Since userSettings is now empty, the file should be deleted
                expect(fs.unlinkSync).toHaveBeenCalled();
            });

            it('should remove key from JSON when other settings exist', () => {
                // File has multiple settings
                vi.mocked(fs.existsSync).mockReturnValue(true);
                vi.mocked(fs.readFileSync).mockReturnValue(
                    JSON.stringify({
                        selectedRepositoryPath: '/some/path',
                        preferredModelIdentifier: 'copilot/gpt-4.1',
                    })
                );
                service = new WorkspaceSettingsService(mockContext);

                // Clear only the repository path
                service.setSelectedRepositoryPath(undefined);
                vi.advanceTimersByTime(600);

                // File should be written (not deleted) with only the model identifier
                expect(fs.unlinkSync).not.toHaveBeenCalled();
                const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
                const writtenContent = writeCall?.[1] as string;
                const parsed = JSON.parse(writtenContent);
                expect(parsed.selectedRepositoryPath).toBeUndefined();
                expect(parsed.preferredModelIdentifier).toBe('copilot/gpt-4.1');
            });

            it('should store absolute path when workspace root is undefined', () => {
                (vscode.workspace as any).workspaceFolders = undefined;

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/some/repo');
                vi.advanceTimersByTime(600);

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining(
                        '"selectedRepositoryPath": "/some/repo"'
                    ),
                    'utf-8'
                );
            });
        });

        describe('getSelectedRepositoryPath', () => {
            it('should resolve "." back to workspace root path', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];
                vi.mocked(fs.readFileSync).mockReturnValue(
                    JSON.stringify({
                        selectedRepositoryPath: '.',
                    })
                );

                service = new WorkspaceSettingsService(mockContext);

                expect(service.getSelectedRepositoryPath()).toBe(
                    '/test/workspace'
                );
            });

            it('should return undefined when "." stored but no workspace folders', () => {
                (vscode.workspace as any).workspaceFolders = undefined;
                vi.mocked(fs.readFileSync).mockReturnValue(
                    JSON.stringify({
                        selectedRepositoryPath: '.',
                    })
                );

                service = new WorkspaceSettingsService(mockContext);

                expect(service.getSelectedRepositoryPath()).toBeUndefined();
            });

            it('should return absolute path as-is when not "."', () => {
                vi.mocked(fs.readFileSync).mockReturnValue(
                    JSON.stringify({
                        selectedRepositoryPath: '/custom/repo/path',
                    })
                );

                service = new WorkspaceSettingsService(mockContext);

                expect(service.getSelectedRepositoryPath()).toBe(
                    '/custom/repo/path'
                );
            });

            it('should return undefined when no path is stored', () => {
                vi.mocked(fs.readFileSync).mockReturnValue('{}');

                service = new WorkspaceSettingsService(mockContext);

                expect(service.getSelectedRepositoryPath()).toBeUndefined();
            });
        });

        describe('path normalization edge cases', () => {
            it('should handle Windows paths with case differences', () => {
                // Simulate Windows behavior
                const originalPlatform = process.platform;
                Object.defineProperty(process, 'platform', { value: 'win32' });

                try {
                    (vscode.workspace as any).workspaceFolders = [
                        { uri: { fsPath: 'C:\\Test\\Workspace' } },
                    ];

                    service = new WorkspaceSettingsService(mockContext);

                    service.setSelectedRepositoryPath('c:\\test\\workspace');
                    vi.advanceTimersByTime(600);

                    // Normalized to workspace root - not persisted
                    expect(fs.writeFileSync).not.toHaveBeenCalled();
                } finally {
                    // Always restore platform, even if test fails
                    Object.defineProperty(process, 'platform', {
                        value: originalPlatform,
                    });
                }
            });

            it('should handle paths with multiple consecutive slashes', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test///workspace');
                vi.advanceTimersByTime(600);

                // Normalized to workspace root - not persisted
                expect(fs.writeFileSync).not.toHaveBeenCalled();
            });

            it('should not match different paths that look similar', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test/workspace-other');
                vi.advanceTimersByTime(600);

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining(
                        '"selectedRepositoryPath": "/test/workspace-other"'
                    ),
                    'utf-8'
                );
            });

            it('should not match parent directory as workspace root', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace/subdir' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test/workspace');
                vi.advanceTimersByTime(600);

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining(
                        '"selectedRepositoryPath": "/test/workspace"'
                    ),
                    'utf-8'
                );
            });
        });
    });

    describe('recoverValidSettings', () => {
        it('should recover valid settings when config has invalid values', () => {
            // Config with valid maxIterations but invalid maxSubagentsPerSession
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    maxIterations: 50,
                    maxSubagentsPerSession: 'not a number', // Invalid
                })
            );

            service = new WorkspaceSettingsService(mockContext);

            // Valid setting should be preserved
            expect(service.getMaxIterations()).toBe(50);
            // Invalid setting should fall back to default
            expect(service.getMaxSubagentsPerSession()).toBe(10);
        });

        it('should ignore unknown keys in config', () => {
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    maxIterations: 25,
                    unknownKey: 'some value',
                    anotherUnknown: 123,
                })
            );

            service = new WorkspaceSettingsService(mockContext);

            // Known valid setting should work
            expect(service.getMaxIterations()).toBe(25);
        });

        it('should recover all valid settings from partially invalid config', () => {
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    maxIterations: 75,
                    maxSubagentsPerSession: 5,
                    requestTimeoutSeconds: 'invalid', // Invalid
                    selectedRepositoryPath: '/valid/path',
                })
            );

            service = new WorkspaceSettingsService(mockContext);

            expect(service.getMaxIterations()).toBe(75);
            expect(service.getMaxSubagentsPerSession()).toBe(5);
            expect(service.getRequestTimeoutSeconds()).toBe(600); // Default
            expect(service.getSelectedRepositoryPath()).toBe('/valid/path');
        });

        it('should handle completely invalid config by using all defaults', () => {
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    maxIterations: 'invalid',
                    maxSubagentsPerSession: null,
                    requestTimeoutSeconds: [],
                })
            );

            service = new WorkspaceSettingsService(mockContext);

            // All should be defaults
            expect(service.getMaxIterations()).toBe(100);
            expect(service.getMaxSubagentsPerSession()).toBe(10);
            expect(service.getRequestTimeoutSeconds()).toBe(600);
        });

        it('should handle malformed JSON gracefully', () => {
            vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }');

            // Should not throw, should use defaults
            service = new WorkspaceSettingsService(mockContext);

            expect(service.getMaxIterations()).toBe(100);
        });

        it('should handle non-object JSON (null) gracefully', () => {
            vi.mocked(fs.readFileSync).mockReturnValue('null');

            // Should not throw, should use defaults
            service = new WorkspaceSettingsService(mockContext);

            expect(service.getMaxIterations()).toBe(100);
            expect(service.getMaxSubagentsPerSession()).toBe(10);
        });

        it('should handle non-object JSON (array) gracefully', () => {
            vi.mocked(fs.readFileSync).mockReturnValue('[1, 2, 3]');

            // Should not throw, should use defaults
            service = new WorkspaceSettingsService(mockContext);

            expect(service.getMaxIterations()).toBe(100);
        });

        it('should handle non-object JSON (number) gracefully', () => {
            vi.mocked(fs.readFileSync).mockReturnValue('123');

            // Should not throw, should use defaults
            service = new WorkspaceSettingsService(mockContext);

            expect(service.getMaxIterations()).toBe(100);
        });

        it('should handle non-object JSON (string) gracefully', () => {
            vi.mocked(fs.readFileSync).mockReturnValue('"just a string"');

            // Should not throw, should use defaults
            service = new WorkspaceSettingsService(mockContext);

            expect(service.getMaxIterations()).toBe(100);
        });
    });

    describe('reload suppression during save operations', () => {
        it('should not reload settings during write operation', () => {
            service = new WorkspaceSettingsService(mockContext);

            // Trigger a setting change which will write
            service.setSetting('maxIterations', 50);
            vi.advanceTimersByTime(600); // Debounce + write

            // Simulate file watcher detecting our own write
            // The suppressReloadUntil timestamp should prevent reload
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({ maxIterations: 999 }) // Different value
            );

            // Advance time but not past the grace period (500ms)
            vi.advanceTimersByTime(100);

            // Value should still be what we set, not reloaded
            expect(service.getMaxIterations()).toBe(50);
        });

        it('should not reload settings while save is pending (race condition fix)', () => {
            service = new WorkspaceSettingsService(mockContext);

            // Set a value - this schedules a debounced save (500ms)
            // and sets suppressReloadUntil to now + 1000ms
            service.setSetting('maxIterations', 50);

            // Simulate external file change BEFORE our save executes
            // Mock what loadSettings would read if it were allowed to run
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({ maxIterations: 999 })
            );

            // Advance 300ms (file watcher debounce) - still before our 500ms save
            vi.advanceTimersByTime(350);

            // Our in-memory value should still be 50, not overwritten by "external" 999
            expect(service.getMaxIterations()).toBe(50);

            // Now let the save complete
            vi.advanceTimersByTime(200); // Total 550ms, past the 500ms debounce

            // Value should still be 50
            expect(service.getMaxIterations()).toBe(50);

            // And our value should have been written to disk
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('"maxIterations": 50'),
                'utf-8'
            );
        });
    });

    describe('clearWorkspaceSettings', () => {
        it('should preserve preferredModelIdentifier and selectedRepositoryPath', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    preferredModelIdentifier: 'gpt-4o',
                    selectedRepositoryPath: '/test/repo',
                    maxIterations: 5, // Non-default value (default is 100)
                    logLevel: 'debug', // Non-default value (default is 'info')
                })
            );
            service = new WorkspaceSettingsService(mockContext);

            service.clearWorkspaceSettings();

            // Preserved settings should remain
            expect(service.getSetting('preferredModelIdentifier', '')).toBe(
                'gpt-4o'
            );
            expect(service.getSetting('selectedRepositoryPath', '')).toBe(
                '/test/repo'
            );
            // Other settings should be reset to defaults
            expect(service.getMaxIterations()).toBe(100); // default
            expect(service.getSetting('logLevel', 'info')).toBe('info'); // default
        });

        it('should delete settings file when only defaults remain', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    maxIterations: 50,
                    logLevel: 'debug',
                })
            );
            service = new WorkspaceSettingsService(mockContext);

            service.clearWorkspaceSettings();

            expect(fs.unlinkSync).toHaveBeenCalledWith(expect.any(String));
        });

        it('should not delete settings file when preserved settings exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    preferredModelIdentifier: 'gpt-4o',
                    maxIterations: 100,
                })
            );
            service = new WorkspaceSettingsService(mockContext);
            vi.mocked(fs.unlinkSync).mockClear();

            service.clearWorkspaceSettings();

            expect(fs.unlinkSync).not.toHaveBeenCalled();
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('"preferredModelIdentifier": "gpt-4o"'),
                'utf-8'
            );
        });
    });

    describe('resetAllSettings', () => {
        it('should clear all settings including preserved ones', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    preferredModelIdentifier: 'gpt-4o',
                    selectedRepositoryPath: '/test/repo',
                    maxIterations: 5, // Non-default value (default is 100)
                })
            );
            service = new WorkspaceSettingsService(mockContext);

            service.resetAllSettings();

            // All settings should be reset to defaults (fallback to empty string)
            expect(service.getSetting('preferredModelIdentifier', '')).toBe('');
            expect(service.getSetting('selectedRepositoryPath', '')).toBe('');
            expect(service.getMaxIterations()).toBe(100); // default is 100
        });

        it('should delete settings file when all settings are cleared', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    preferredModelIdentifier: 'gpt-4o',
                    maxIterations: 100,
                })
            );
            service = new WorkspaceSettingsService(mockContext);
            vi.mocked(fs.unlinkSync).mockClear();

            service.resetAllSettings();

            expect(fs.unlinkSync).toHaveBeenCalledWith(expect.any(String));
        });
    });

    describe('setSetting default-equality behavior', () => {
        it('should not persist values that equal the schema default', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue('{}');
            service = new WorkspaceSettingsService(mockContext);
            vi.mocked(fs.writeFileSync).mockClear();
            vi.mocked(fs.unlinkSync).mockClear();

            // maxIterations default is 100
            service.setSetting('maxIterations', 100);
            vi.advanceTimersByTime(600);

            // Should not write the default value - file should be deleted (empty userSettings)
            expect(fs.writeFileSync).not.toHaveBeenCalled();
            expect(fs.unlinkSync).toHaveBeenCalled();
        });

        it('should persist values that differ from the schema default', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue('{}');
            service = new WorkspaceSettingsService(mockContext);
            vi.mocked(fs.writeFileSync).mockClear();

            // Set a non-default value
            service.setSetting('maxIterations', 50);
            vi.advanceTimersByTime(600);

            expect(fs.writeFileSync).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('"maxIterations": 50'),
                'utf-8'
            );
        });

        it('should remove previously-set value when reset to default', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({ maxIterations: 50 })
            );
            service = new WorkspaceSettingsService(mockContext);
            vi.mocked(fs.writeFileSync).mockClear();
            vi.mocked(fs.unlinkSync).mockClear();

            // Reset to default value
            service.setSetting('maxIterations', 100);
            vi.advanceTimersByTime(600);

            // Should delete file since no non-default values remain
            expect(fs.writeFileSync).not.toHaveBeenCalled();
            expect(fs.unlinkSync).toHaveBeenCalled();
        });

        it('should still update runtime settings even when not persisting', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({ maxIterations: 50 })
            );
            service = new WorkspaceSettingsService(mockContext);

            // Reset to default - should still update runtime value
            service.setSetting('maxIterations', 100);

            expect(service.getMaxIterations()).toBe(100);
        });
    });

    describe('file watcher reload suppression', () => {
        let fileWatcherHandlers: {
            change?: () => void;
            create?: () => void;
            delete?: () => void;
        };

        beforeEach(() => {
            fileWatcherHandlers = {};

            // Ensure workspace folders are set
            (vscode.workspace as any).workspaceFolders = [
                { uri: { fsPath: '/test/workspace' } },
            ];

            // Override createFileSystemWatcher to capture handlers
            vi.mocked(
                vscode.workspace.createFileSystemWatcher
            ).mockImplementation(
                () =>
                    ({
                        onDidChange: vi.fn((cb: () => void) => {
                            fileWatcherHandlers.change = cb;
                            return { dispose: vi.fn() };
                        }),
                        onDidCreate: vi.fn((cb: () => void) => {
                            fileWatcherHandlers.create = cb;
                            return { dispose: vi.fn() };
                        }),
                        onDidDelete: vi.fn((cb: () => void) => {
                            fileWatcherHandlers.delete = cb;
                            return { dispose: vi.fn() };
                        }),
                        dispose: vi.fn(),
                    }) as unknown as vscode.FileSystemWatcher
            );

            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue('{}');
        });

        it('should not reload when file changes during save debounce period', () => {
            service = new WorkspaceSettingsService(mockContext);
            vi.mocked(fs.readFileSync).mockClear();

            // Start a save operation
            service.setSetting('maxIterations', 50);

            // Simulate external file change during debounce
            vi.advanceTimersByTime(100); // Still within SAVE_DEBOUNCE_MS (500ms)
            fileWatcherHandlers.change?.();

            // Advance past RELOAD_DEBOUNCE_MS
            vi.advanceTimersByTime(400);

            // Should not have reloaded
            expect(fs.readFileSync).not.toHaveBeenCalled();
        });

        it('should not reload when file changes during write grace period', () => {
            service = new WorkspaceSettingsService(mockContext);
            vi.mocked(fs.readFileSync).mockClear();

            // Start a save operation and complete it
            service.setSetting('maxIterations', 50);
            vi.advanceTimersByTime(550); // Past SAVE_DEBOUNCE_MS, triggers write

            vi.mocked(fs.readFileSync).mockClear();

            // Simulate external file change during grace period
            vi.advanceTimersByTime(100); // Within WRITE_GRACE_MS (500ms)
            fileWatcherHandlers.change?.();

            // Advance past RELOAD_DEBOUNCE_MS
            vi.advanceTimersByTime(400);

            // Should not have reloaded
            expect(fs.readFileSync).not.toHaveBeenCalled();
        });

        it('should reload when file changes after grace period expires', () => {
            service = new WorkspaceSettingsService(mockContext);

            // Complete a save operation
            service.setSetting('maxIterations', 50);
            vi.advanceTimersByTime(550); // Triggers write

            vi.mocked(fs.readFileSync).mockClear();

            // Wait for grace period to expire
            vi.advanceTimersByTime(600); // Past WRITE_GRACE_MS (500ms)

            // Simulate external file change
            fileWatcherHandlers.change?.();

            // Advance past RELOAD_DEBOUNCE_MS (300ms)
            vi.advanceTimersByTime(350);

            // Should have reloaded
            expect(fs.readFileSync).toHaveBeenCalled();
        });

        it('should debounce rapid external file changes', () => {
            service = new WorkspaceSettingsService(mockContext);
            vi.mocked(fs.readFileSync).mockClear();

            // Trigger multiple rapid changes (no save in progress)
            fileWatcherHandlers.change?.();
            vi.advanceTimersByTime(100);
            fileWatcherHandlers.change?.();
            vi.advanceTimersByTime(100);
            fileWatcherHandlers.change?.();

            // Advance past RELOAD_DEBOUNCE_MS from last change
            vi.advanceTimersByTime(350);

            // Should have reloaded only once
            expect(fs.readFileSync).toHaveBeenCalledTimes(1);
        });
    });
});
