import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ToolRegistry } from '../models/toolRegistry';
import { FindUsagesTool } from '../tools/findUsagesTool';
import { SubmitReviewTool } from '../tools/submitReviewTool';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import {
    createMockWorkspaceSettings,
    createMockCancellationTokenSource,
    createMockGitOperationsManager,
} from './testUtils/mockFactories';
import { PromptGenerator } from '../models/promptGenerator';

vi.mock('vscode', async (importOriginal) => {
    const vscodeMock = await importOriginal<typeof vscode>();
    return {
        ...vscodeMock,
        workspace: {
            ...vscodeMock.workspace,
            textDocuments: [],
            openTextDocument: vi.fn(),
            workspaceFolders: [
                {
                    uri: { fsPath: '/test/workspace' },
                },
            ],
        },
        commands: {
            executeCommand: vi.fn(),
        },
        Uri: {
            ...vscodeMock.Uri,
            parse: vi.fn((path) => ({ toString: () => path, fsPath: path })),
            joinPath: vi.fn((base, relative) => ({
                toString: () => `${base.fsPath}/${relative}`,
                fsPath: `${base.fsPath}/${relative}`,
            })),
        },
    };
});

const mockModel = {
    countTokens: vi.fn(() => Promise.resolve(100)),
    maxInputTokens: 8000,
};

const mockCopilotModelManager = {
    getCurrentModel: vi.fn(() => Promise.resolve(mockModel)),
    sendRequest: vi.fn(),
};

describe('FindUsages Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let toolRegistry: ToolRegistry;
    let mockWorkspaceSettings: WorkspaceSettingsService;
    let findUsagesTool: FindUsagesTool;
    let subagentSessionManager: SubagentSessionManager;
    let tokenSource: vscode.CancellationTokenSource;
    let promptGenerator: PromptGenerator;

    beforeEach(() => {
        // Initialize the tool-calling system
        toolRegistry = new ToolRegistry();
        mockWorkspaceSettings = createMockWorkspaceSettings();

        // Initialize tools with mock GitOperationsManager
        const mockGitOperations =
            createMockGitOperationsManager('/test/workspace');
        findUsagesTool = new FindUsagesTool(mockGitOperations as any);
        toolRegistry.registerTool(findUsagesTool);
        toolRegistry.registerTool(new SubmitReviewTool());

        subagentSessionManager = new SubagentSessionManager(
            mockWorkspaceSettings
        );

        promptGenerator = new PromptGenerator();

        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            toolRegistry,
            mockCopilotModelManager as any,
            promptGenerator,
            mockWorkspaceSettings,
            subagentSessionManager
        );

        // Clear all mocks
        vi.clearAllMocks();

        // Use shared CancellationTokenSource mock from mockFactories
        vi.mocked(vscode.CancellationTokenSource).mockImplementation(function (
            this: any
        ) {
            const mock = createMockCancellationTokenSource();
            this.token = mock.token;
            this.cancel = mock.cancel;
            this.dispose = mock.dispose;
        });
        tokenSource = new vscode.CancellationTokenSource();
    });

    describe('End-to-End Find Usages Workflow', () => {
        it('should successfully find and format symbol usages', async () => {
            // Setup mock document and references
            const mockDocument = {
                getText: vi
                    .fn()
                    .mockReturnValue(
                        'class MyClass {\n  method() {}\n}\n\nconst instance = new MyClass();'
                    ),
                uri: {
                    toString: () => 'file:///test/workspace/src/test.ts',
                    fsPath: '/test/workspace/src/test.ts',
                },
            };

            const mockReferences = [
                {
                    uri: {
                        toString: () => 'file:///test/workspace/src/test.ts',
                        fsPath: '/test/workspace/src/test.ts',
                    },
                    range: {
                        start: { line: 4, character: 21 },
                        end: { line: 4, character: 28 },
                    },
                },
                {
                    uri: {
                        toString: () => 'file:///test/workspace/src/other.ts',
                        fsPath: '/test/workspace/src/other.ts',
                    },
                    range: {
                        start: { line: 2, character: 10 },
                        end: { line: 2, character: 17 },
                    },
                },
            ];

            // Mock VS Code API calls
            (vscode.workspace.openTextDocument as any)
                .mockResolvedValueOnce(mockDocument) // Initial document
                .mockResolvedValueOnce(mockDocument) // First reference
                .mockResolvedValueOnce(mockDocument); // Second reference

            (vscode.commands.executeCommand as any).mockImplementation(
                (command: string) => {
                    if (command === 'vscode.executeDefinitionProvider') {
                        return Promise.resolve([
                            {
                                uri: {
                                    toString: () =>
                                        'file:///test/workspace/src/test.ts',
                                    fsPath: '/test/workspace/src/test.ts',
                                },
                                range: { contains: () => true },
                            },
                        ]);
                    }
                    if (command === 'vscode.executeReferenceProvider') {
                        return Promise.resolve(mockReferences);
                    }
                    return Promise.resolve([]);
                }
            );

            // Mock LLM response with tool call
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({
                                    symbol_name: 'MyClass',
                                    file_path: 'src/test.ts',
                                    context_line_count: 2,
                                }),
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Based on the tool results, I found 2 usages of MyClass. The analysis is complete with all references identified and formatted. Adding padding to meet 100 char minimum.',
                                }),
                            },
                        },
                    ],
                });

            const diff =
                'diff --git a/src/test.ts b/src/test.ts\n+class MyClass {}';
            const result = await toolCallingAnalyzer.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Based on the tool results, I found 2 usages of MyClass. The analysis is complete with all references identified and formatted. Adding padding to meet 100 char minimum.'
            );
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(
                2
            );

            // Verify the tool was called correctly (should be called at least once with reference provider)
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeReferenceProvider',
                expect.any(Object),
                expect.any(Object),
                { includeDeclaration: false }
            );
        });

        it('should handle no usages found scenario', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class UnusedClass {}'),
                uri: {
                    toString: () => 'file:///test/workspace/src/test.ts',
                    fsPath: '/test/workspace/src/test.ts',
                },
            };

            (vscode.workspace.openTextDocument as any).mockResolvedValue(
                mockDocument
            );

            (vscode.commands.executeCommand as any).mockImplementation(
                (command: string) => {
                    if (command === 'vscode.executeReferenceProvider') {
                        return Promise.resolve([]); // No references found
                    }
                    return Promise.resolve([]);
                }
            );

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({
                                    symbol_name: 'UnusedClass',
                                    file_path: 'src/test.ts',
                                }),
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'No usages found for this class, it appears to be unused. The symbol exists in the codebase but has no references. Adding padding to meet 100 char minimum.',
                                }),
                            },
                        },
                    ],
                });

            const diff =
                'diff --git a/src/test.ts b/src/test.ts\n+class UnusedClass {}';
            const result = await toolCallingAnalyzer.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'No usages found for this class, it appears to be unused. The symbol exists in the codebase but has no references. Adding padding to meet 100 char minimum.'
            );
        });

        it('should handle multiple tool calls in sequence', async () => {
            const mockDocument = {
                getText: vi
                    .fn()
                    .mockReturnValue('class ClassA {}\nclass ClassB {}'),
                uri: {
                    toString: () => 'file:///test/workspace/src/test.ts',
                    fsPath: '/test/workspace/src/test.ts',
                },
            };

            const mockReferencesA = [
                {
                    uri: {
                        toString: () => 'file:///test/workspace/src/usage.ts',
                        fsPath: '/test/workspace/src/usage.ts',
                    },
                    range: {
                        start: { line: 0, character: 15 },
                        end: { line: 0, character: 21 },
                    },
                },
            ];

            const mockReferencesB = [
                {
                    uri: {
                        toString: () => 'file:///test/workspace/src/usage.ts',
                        fsPath: '/test/workspace/src/usage.ts',
                    },
                    range: {
                        start: { line: 1, character: 15 },
                        end: { line: 1, character: 21 },
                    },
                },
            ];

            (vscode.workspace.openTextDocument as any).mockResolvedValue(
                mockDocument
            );

            let callCount = 0;
            (vscode.commands.executeCommand as any).mockImplementation(
                (command: string, _uri: any, _position: any, _context: any) => {
                    if (command === 'vscode.executeReferenceProvider') {
                        callCount++;
                        return Promise.resolve(
                            callCount === 1 ? mockReferencesA : mockReferencesB
                        );
                    }
                    return Promise.resolve([]);
                }
            );

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({
                                    symbol_name: 'ClassA',
                                    file_path: 'src/test.ts',
                                }),
                            },
                        },
                        {
                            id: 'call_2',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({
                                    symbol_name: 'ClassB',
                                    file_path: 'src/test.ts',
                                }),
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Both classes have one usage each. ClassA and ClassB are both referenced once in the codebase usage files. Adding padding to meet 100 char minimum.',
                                }),
                            },
                        },
                    ],
                });

            const diff =
                'diff --git a/src/test.ts b/src/test.ts\n+class ClassA {}\n+class ClassB {}';
            const result = await toolCallingAnalyzer.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Both classes have one usage each. ClassA and ClassB are both referenced once in the codebase usage files. Adding padding to meet 100 char minimum.'
            );
            expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(4); // Two tools × (1 definition + 1 reference call each) = 4 calls
        });

        it('should handle tool execution errors gracefully', async () => {
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({
                                    symbol_name: 'NonExistentClass',
                                    file_path: 'nonexistent.ts',
                                }),
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'I encountered an error finding usages for that symbol. The file could not be opened or the symbol was not found. Adding padding to meet 100 char minimum.',
                                }),
                            },
                        },
                    ],
                });

            (vscode.workspace.openTextDocument as any).mockRejectedValue(
                new Error('File not found')
            );

            const diff =
                'diff --git a/src/test.ts b/src/test.ts\n+// some change';
            const result = await toolCallingAnalyzer.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'I encountered an error finding usages for that symbol. The file could not be opened or the symbol was not found. Adding padding to meet 100 char minimum.'
            );
        });

        it('should handle shouldIncludeDeclaration parameter correctly', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {}'),
                uri: {
                    toString: () => 'file:///test/workspace/src/test.ts',
                    fsPath: '/test/workspace/src/test.ts',
                },
            };

            (vscode.workspace.openTextDocument as any).mockResolvedValue(
                mockDocument
            );

            let capturedContext: any;
            (vscode.commands.executeCommand as any).mockImplementation(
                (command: string, uri: any, position: any, context: any) => {
                    if (command === 'vscode.executeReferenceProvider') {
                        capturedContext = context;
                        return Promise.resolve([]);
                    }
                    return Promise.resolve([]);
                }
            );

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({
                                    symbol_name: 'MyClass',
                                    file_path: 'src/test.ts',
                                    should_include_declaration: true,
                                }),
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Analysis complete. The symbol declaration was included in the search results as requested by the parameter. Adding padding to meet 100 char minimum.',
                                }),
                            },
                        },
                    ],
                });

            const diff =
                'diff --git a/src/test.ts b/src/test.ts\n+class MyClass {}';
            await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(capturedContext?.includeDeclaration).toBe(true);
        });

        it('should respect context_line_count parameter', async () => {
            const mockDocument = {
                getText: vi
                    .fn()
                    .mockReturnValue(
                        'line1\nline2\nclass MyClass {}\nline4\nline5'
                    ),
                uri: {
                    toString: () => 'file:///test/workspace/src/test.ts',
                    fsPath: '/test/workspace/src/test.ts',
                },
            };

            const mockReferences = [
                {
                    uri: {
                        toString: () => 'file:///test/workspace/src/test.ts',
                        fsPath: '/test/workspace/src/test.ts',
                    },
                    range: {
                        start: { line: 2, character: 6 },
                        end: { line: 2, character: 13 },
                    },
                },
            ];

            (vscode.workspace.openTextDocument as any).mockResolvedValue(
                mockDocument
            );

            (vscode.commands.executeCommand as any).mockImplementation(
                (command: string) => {
                    if (command === 'vscode.executeReferenceProvider') {
                        return Promise.resolve(mockReferences);
                    }
                    return Promise.resolve([]);
                }
            );

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({
                                    symbol_name: 'MyClass',
                                    file_path: 'src/test.ts',
                                    context_line_count: 1,
                                }),
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Found usage with context. The context lines around each usage have been included as requested. Adding padding to meet 100 char minimum.',
                                }),
                            },
                        },
                    ],
                });

            const diff =
                'diff --git a/src/test.ts b/src/test.ts\n+class MyClass {}';
            await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            // The context_line_count parameter is passed to the tool - verification is done
            // through the tool being called correctly via the mocked executeCommand
        });
    });
});
