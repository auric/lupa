import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetSymbolsOverviewTool } from '../tools/getSymbolsOverviewTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { ToolRegistry } from '../models/toolRegistry';
import { ToolExecutor } from '../models/toolExecutor';

// Mock vscode with more realistic behavior
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            fs: {
                stat: vi.fn(),
                readDirectory: vi.fn(),
                readFile: vi.fn()
            }
        },
        commands: {
            executeCommand: vi.fn()
        },
        Uri: {
            file: vi.fn((path) => ({
                toString: () => path,
                fsPath: path,
                path: path
            }))
        },
        FileType: {
            File: 1,
            Directory: 2
        },
        SymbolKind: {
            Class: 5,
            Function: 12,
            Interface: 11,
            Method: 6,
            Variable: 13
        }
    };
});

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn((path) => path)
    }
}));

// Mock readGitignore to simulate .gitignore filtering
vi.mock('../lib/pathUtils', () => ({
    readGitignore: vi.fn().mockResolvedValue('node_modules\n*.log\n.env')
}));

// Mock ignore library with realistic behavior
vi.mock('ignore', () => ({
    default: vi.fn(() => ({
        add: vi.fn().mockReturnThis(),
        checkIgnore: vi.fn((path) => {
            // Simulate ignoring node_modules and log files
            const ignored = path.includes('node_modules') || path.endsWith('.log');
            return { ignored };
        })
    }))
}));

describe('GetSymbolsOverviewTool (Integration Tests)', () => {
    let getSymbolsOverviewTool: GetSymbolsOverviewTool;
    let mockGitOperationsManager: GitOperationsManager;
    let toolRegistry: ToolRegistry;
    let toolExecutor: ToolExecutor;

    beforeEach(() => {
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/project' }
            })
        } as any;

        getSymbolsOverviewTool = new GetSymbolsOverviewTool(mockGitOperationsManager);

        // Set up tool registry and executor for integration testing
        toolRegistry = new ToolRegistry();
        toolRegistry.registerTool(getSymbolsOverviewTool);
        toolExecutor = new ToolExecutor(toolRegistry);

        vi.clearAllMocks();
    });

    describe('End-to-End Workflow', () => {
        it('should handle complete project analysis workflow', async () => {
            // Simulate a real project structure
            vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri) => {
                const path = uri.toString();
                if (path.includes('src')) {
                    return { type: vscode.FileType.Directory } as any;
                } else if (path.endsWith('.ts') || path.endsWith('.js')) {
                    return { type: vscode.FileType.File } as any;
                }
                throw new Error('File not found');
            });

            // Mock realistic directory structure with exact path matching
            vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation(async (uri) => {
                const uriPath = uri.toString();

                // Normalize path separators for cross-platform compatibility
                const normalizedPath = uriPath.replace(/\\/g, '/');

                // Use exact path matching to prevent infinite recursion
                if (normalizedPath.includes('/test/project/src') && !normalizedPath.includes('/test/project/src/')) {
                    return [
                        ['services', vscode.FileType.Directory],
                        ['models', vscode.FileType.Directory],
                        ['utils', vscode.FileType.Directory],
                        ['index.ts', vscode.FileType.File],
                        ['node_modules', vscode.FileType.Directory] // Should be ignored
                    ];
                } else if (normalizedPath.includes('/test/project/src/services')) {
                    return [
                        ['userService.ts', vscode.FileType.File],
                        ['authService.ts', vscode.FileType.File]
                    ];
                } else if (normalizedPath.includes('/test/project/src/models')) {
                    return [
                        ['user.ts', vscode.FileType.File],
                        ['auth.ts', vscode.FileType.File]
                    ];
                } else if (normalizedPath.includes('/test/project/src/utils')) {
                    return [
                        ['helpers.ts', vscode.FileType.File],
                        ['debug.log', vscode.FileType.File] // Should be ignored
                    ];
                }
                return [];
            });

            // Mock symbols for different files
            vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, uri) => {
                const path = uri.toString();

                if (path.includes('index.ts')) {
                    return [
                        { name: 'App', kind: vscode.SymbolKind.Class, children: [] },
                        { name: 'main', kind: vscode.SymbolKind.Function, children: [] }
                    ];
                } else if (path.includes('userService.ts')) {
                    return [
                        { name: 'UserService', kind: vscode.SymbolKind.Class, children: [] },
                        { name: 'createUser', kind: vscode.SymbolKind.Function, children: [] }
                    ];
                } else if (path.includes('authService.ts')) {
                    return [
                        { name: 'AuthService', kind: vscode.SymbolKind.Class, children: [] }
                    ];
                } else if (path.includes('user.ts')) {
                    return [
                        { name: 'User', kind: vscode.SymbolKind.Interface, children: [] },
                        { name: 'UserRole', kind: vscode.SymbolKind.Interface, children: [] }
                    ];
                } else if (path.includes('auth.ts')) {
                    return [
                        { name: 'AuthToken', kind: vscode.SymbolKind.Interface, children: [] }
                    ];
                } else if (path.includes('helpers.ts')) {
                    return [
                        { name: 'formatDate', kind: vscode.SymbolKind.Function, children: [] },
                        { name: 'API_URL', kind: vscode.SymbolKind.Variable, children: [] }
                    ];
                }

                return [];
            });

            // Execute through tool executor
            const toolCalls = [
                {
                    toolName: 'get_symbols_overview',
                    args: { path: 'src' }
                }
            ];

            const results = await toolExecutor.executeTools(toolCalls);

            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(true);
            expect(results[0].result).toEqual([
                'src/index.ts:',
                '  - App (class)',
                '  - main (function)',
                '',
                'src/models/auth.ts:',
                '  - AuthToken (interface)',
                '',
                'src/models/user.ts:',
                '  - User (interface)',
                '  - UserRole (interface)',
                '',
                'src/services/authService.ts:',
                '  - AuthService (class)',
                '',
                'src/services/userService.ts:',
                '  - UserService (class)',
                '  - createUser (function)',
                '',
                'src/utils/helpers.ts:',
                '  - formatDate (function)',
                '  - API_URL (variable)'
            ]);

            // Verify .gitignore filtering worked (node_modules and .log files should be ignored)
            expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
                'vscode.executeDocumentSymbolProvider',
                expect.objectContaining({
                    toString: expect.stringContaining('node_modules')
                })
            );
            expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
                'vscode.executeDocumentSymbolProvider',
                expect.objectContaining({
                    toString: expect.stringContaining('debug.log')
                })
            );
        });

        it('should handle single file analysis through tool executor', async () => {
            // Mock single file
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.File
            } as any);

            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
                { name: 'Calculator', kind: vscode.SymbolKind.Class, children: [] },
                { name: 'add', kind: vscode.SymbolKind.Method, children: [] },
                { name: 'subtract', kind: vscode.SymbolKind.Method, children: [] }
            ]);

            const toolCalls = [
                {
                    toolName: 'get_symbols_overview',
                    args: { path: 'src/calculator.ts' }
                }
            ];

            const results = await toolExecutor.executeTools(toolCalls);

            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(true);
            expect(results[0].result).toEqual([
                'src/calculator.ts:',
                '  - Calculator (class)',
                '  - add (method)',
                '  - subtract (method)'
            ]);
        });

        it('should handle error cases gracefully through tool executor', async () => {
            // Mock file not found
            vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error('File not found'));

            const toolCalls = [
                {
                    toolName: 'get_symbols_overview',
                    args: { path: 'nonexistent/file.ts' }
                }
            ];

            const results = await toolExecutor.executeTools(toolCalls);

            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(true);
            expect(results[0].result).toEqual([
                "Error getting symbols overview: Failed to get symbols overview for 'nonexistent/file.ts': Path 'nonexistent/file.ts' not found"
            ]);
        });

        it('should handle invalid tool arguments', async () => {
            const toolCalls = [
                {
                    toolName: 'get_symbols_overview',
                    args: { path: '' } // Empty path should fail validation
                }
            ];

            const results = await toolExecutor.executeTools(toolCalls);

            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(false);
            expect(results[0].error).toContain('Path cannot be empty');
        });
    });

    describe('Performance and Scalability', () => {
        it('should handle large directory structures efficiently', async () => {
            // Mock a large directory structure
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.Directory
            } as any);

            // Generate many files
            const manyFiles: [string, vscode.FileType][] = Array.from({ length: 50 }, (_, i) => [`file${i}.ts`, vscode.FileType.File] as [string, vscode.FileType]);
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue(manyFiles);

            // Mock symbols for each file
            vi.mocked(vscode.commands.executeCommand).mockImplementation(async () => [
                { name: 'TestClass', kind: vscode.SymbolKind.Class, children: [] }
            ]);

            const start = Date.now();
            const result = await getSymbolsOverviewTool.execute({ path: 'large-project' });
            const duration = Date.now() - start;

            // Should complete in reasonable time (less than 1 second for this test)
            expect(duration).toBeLessThan(1000);
            expect(result.length).toBeGreaterThan(50); // Should have results for all files
        });
    });

    describe('Tool Registry Integration', () => {
        it('should be retrievable from tool registry', () => {
            const retrievedTool = toolRegistry.getTool('get_symbols_overview');
            expect(retrievedTool).toBe(getSymbolsOverviewTool);
        });

        it('should provide correct VS Code tool configuration', () => {
            const vscodeTools = getSymbolsOverviewTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('get_symbols_overview');
            expect(vscodeTools.inputSchema).toBeDefined();
            expect((vscodeTools.inputSchema as any).properties).toHaveProperty('path');
        });
    });
});