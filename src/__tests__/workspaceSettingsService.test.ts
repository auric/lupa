import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';

vi.mock('fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

vi.mock('vscode', async (importOriginal) => {
    const actual = await importOriginal<typeof vscode>();
    return {
        ...actual,
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
            onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
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
            it('should store "." when repo path matches workspace root exactly', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test/workspace');
                vi.advanceTimersByTime(600); // Trigger debounced save

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining('"selectedRepositoryPath": "."'),
                    'utf-8'
                );
            });

            it('should store "." when paths differ only in trailing slash', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test/workspace/');
                vi.advanceTimersByTime(600);

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining('"selectedRepositoryPath": "."'),
                    'utf-8'
                );
            });

            it('should store "." when paths differ only in backslash vs forward slash', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: 'C:\\test\\workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('C:/test/workspace');
                vi.advanceTimersByTime(600);

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining('"selectedRepositoryPath": "."'),
                    'utf-8'
                );
            });

            it('should store "." when paths differ in double slashes', () => {
                (vscode.workspace as any).workspaceFolders = [
                    { uri: { fsPath: '/test/workspace' } },
                ];

                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath('/test//workspace');
                vi.advanceTimersByTime(600);

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining('"selectedRepositoryPath": "."'),
                    'utf-8'
                );
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

            it('should store undefined when called with undefined', () => {
                service = new WorkspaceSettingsService(mockContext);

                service.setSelectedRepositoryPath(undefined);
                vi.advanceTimersByTime(600);

                // Should not contain selectedRepositoryPath or should have it as null/undefined
                const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
                const writtenContent = writeCall?.[1] as string;
                const parsed = JSON.parse(writtenContent);
                expect(parsed.selectedRepositoryPath).toBeUndefined();
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

                    expect(fs.writeFileSync).toHaveBeenCalledWith(
                        expect.any(String),
                        expect.stringContaining(
                            '"selectedRepositoryPath": "."'
                        ),
                        'utf-8'
                    );
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

                expect(fs.writeFileSync).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.stringContaining('"selectedRepositoryPath": "."'),
                    'utf-8'
                );
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
});
