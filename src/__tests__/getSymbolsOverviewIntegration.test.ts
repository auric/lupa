import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetSymbolsOverviewTool } from '../tools/getSymbolsOverviewTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { ToolRegistry } from '../models/toolRegistry';
import { ToolExecutor } from '../models/toolExecutor';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';

/**
 * Create a mock WorkspaceSettingsService for testing
 */
function createMockWorkspaceSettings(): WorkspaceSettingsService {
    return {
        getMaxToolCalls: () => ANALYSIS_LIMITS.maxToolCalls.default,
        getMaxIterations: () => ANALYSIS_LIMITS.maxIterations.default,
        getRequestTimeoutSeconds: () => ANALYSIS_LIMITS.requestTimeoutSeconds.default
    } as WorkspaceSettingsService;
}

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
vi.mock('../utils/gitUtils', () => ({
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

// Mock SymbolExtractor
vi.mock('../utils/symbolExtractor');

describe('GetSymbolsOverviewTool (Integration Tests)', () => {
    let getSymbolsOverviewTool: GetSymbolsOverviewTool;
    let mockGitOperationsManager: GitOperationsManager;
    let mockSymbolExtractor: any;
    let toolRegistry: ToolRegistry;
    let toolExecutor: ToolExecutor;

    beforeEach(() => {
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/project' }
            })
        } as any;

        // Mock SymbolExtractor with all required methods
        mockSymbolExtractor = {
            getGitRootPath: vi.fn().mockReturnValue('/test/project'),
            getPathStat: vi.fn(),
            extractSymbolsWithContext: vi.fn(),
            getDirectorySymbols: vi.fn(),
            getTextDocument: vi.fn()
        };

        getSymbolsOverviewTool = new GetSymbolsOverviewTool(mockGitOperationsManager, mockSymbolExtractor);

        // Set up tool registry and executor for integration testing
        toolRegistry = new ToolRegistry();
        toolRegistry.registerTool(getSymbolsOverviewTool);
        toolExecutor = new ToolExecutor(toolRegistry, createMockWorkspaceSettings());

        vi.clearAllMocks();
    });

    describe('End-to-End Workflow', () => {
        it('should handle complete project analysis workflow', async () => {
            // Mock the SymbolExtractor to return appropriate directory results
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory
            });

            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue([
                {
                    filePath: 'src/index.ts',
                    symbols: [
                        {
                            name: 'App',
                            kind: vscode.SymbolKind.Class,
                            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
                            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
                            children: []
                        },
                        {
                            name: 'main',
                            kind: vscode.SymbolKind.Function,
                            range: { start: { line: 12, character: 0 }, end: { line: 15, character: 1 } },
                            selectionRange: { start: { line: 12, character: 9 }, end: { line: 12, character: 13 } },
                            children: []
                        }
                    ]
                },
                {
                    filePath: 'src/models/auth.ts',
                    symbols: [
                        {
                            name: 'AuthToken',
                            kind: vscode.SymbolKind.Interface,
                            range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
                            selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 19 } },
                            children: []
                        }
                    ]
                },
                {
                    filePath: 'src/models/user.ts',
                    symbols: [
                        {
                            name: 'User',
                            kind: vscode.SymbolKind.Interface,
                            range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
                            selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 14 } },
                            children: []
                        },
                        {
                            name: 'UserRole',
                            kind: vscode.SymbolKind.Interface,
                            range: { start: { line: 7, character: 0 }, end: { line: 10, character: 0 } },
                            selectionRange: { start: { line: 7, character: 10 }, end: { line: 7, character: 18 } },
                            children: []
                        }
                    ]
                },
                {
                    filePath: 'src/services/authService.ts',
                    symbols: [
                        {
                            name: 'AuthService',
                            kind: vscode.SymbolKind.Class,
                            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
                            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 17 } },
                            children: []
                        }
                    ]
                },
                {
                    filePath: 'src/services/userService.ts',
                    symbols: [
                        {
                            name: 'UserService',
                            kind: vscode.SymbolKind.Class,
                            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
                            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 17 } },
                            children: []
                        },
                        {
                            name: 'createUser',
                            kind: vscode.SymbolKind.Function,
                            range: { start: { line: 12, character: 0 }, end: { line: 15, character: 1 } },
                            selectionRange: { start: { line: 12, character: 9 }, end: { line: 12, character: 19 } },
                            children: []
                        }
                    ]
                },
                {
                    filePath: 'src/utils/helpers.ts',
                    symbols: [
                        {
                            name: 'formatDate',
                            kind: vscode.SymbolKind.Function,
                            range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
                            selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 19 } },
                            children: []
                        },
                        {
                            name: 'API_URL',
                            kind: vscode.SymbolKind.Variable,
                            range: { start: { line: 7, character: 0 }, end: { line: 7, character: 30 } },
                            selectionRange: { start: { line: 7, character: 6 }, end: { line: 7, character: 13 } },
                            children: []
                        }
                    ]
                }
            ]);

            // Execute through tool executor
            const toolCalls = [
                {
                    name: 'get_symbols_overview',
                    args: { path: 'src' }
                }
            ];

            const results = await toolExecutor.executeTools(toolCalls);

            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(true);
            expect(typeof results[0].result).toBe('string');
            expect(results[0].result).toContain('src/index.ts:');
            expect(results[0].result).toContain('App (class)');
            expect(results[0].result).toContain('main (function)');
            expect(results[0].result).toContain('AuthToken (interface)');
            expect(results[0].result).toContain('UserService (class)');
            expect(results[0].result).toContain('formatDate (function)');
            expect(results[0].result).toContain('API_URL (variable)');
        });

        it('should handle single file analysis through tool executor', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File
            });

            const mockDocument = { getText: vi.fn().mockReturnValue('class Calculator {}') };

            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [
                    {
                        name: 'Calculator',
                        kind: vscode.SymbolKind.Class,
                        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
                        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 16 } },
                        children: []
                    },
                    {
                        name: 'add',
                        kind: vscode.SymbolKind.Method,
                        range: { start: { line: 2, character: 2 }, end: { line: 4, character: 3 } },
                        selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 5 } },
                        children: []
                    },
                    {
                        name: 'subtract',
                        kind: vscode.SymbolKind.Method,
                        range: { start: { line: 6, character: 2 }, end: { line: 8, character: 3 } },
                        selectionRange: { start: { line: 6, character: 2 }, end: { line: 6, character: 10 } },
                        children: []
                    }
                ],
                document: mockDocument
            });

            const toolCalls = [
                {
                    name: 'get_symbols_overview',
                    args: { path: 'src/calculator.ts' }
                }
            ];

            const results = await toolExecutor.executeTools(toolCalls);

            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(true);
            expect(typeof results[0].result).toBe('string');
            expect(results[0].result).toContain('Calculator (class)');
            expect(results[0].result).toContain('add (method)');
            expect(results[0].result).toContain('subtract (method)');
        });

        it('should handle error cases gracefully through tool executor', async () => {
            // Mock SymbolExtractor to return null stat (file not found)
            mockSymbolExtractor.getPathStat.mockResolvedValue(null);

            const toolCalls = [
                {
                    name: 'get_symbols_overview',
                    args: { path: 'nonexistent/file.ts' }
                }
            ];

            const results = await toolExecutor.executeTools(toolCalls);

            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(false);
            expect(results[0].error).toContain("Path 'nonexistent/file.ts' not found");
        });

        it('should handle invalid tool arguments', async () => {
            const toolCalls = [
                {
                    name: 'get_symbols_overview',
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
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory
            });

            // Generate many file results
            const manyFileResults = Array.from({ length: 50 }, (_, i) => ({
                filePath: `large-project/file${i}.ts`,
                symbols: [
                    {
                        name: 'TestClass',
                        kind: vscode.SymbolKind.Class,
                        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
                        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 15 } },
                        children: []
                    }
                ]
            }));

            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue(manyFileResults);

            const start = Date.now();
            const result = await getSymbolsOverviewTool.execute({ path: 'large-project' });
            const duration = Date.now() - start;

            // Should complete in reasonable time (less than 1 second for this test)
            expect(duration).toBeLessThan(1000);
            expect(result.success).toBe(true);
            expect(result.data).toContain('TestClass (class)'); // Should have results
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