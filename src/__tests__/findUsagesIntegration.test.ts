import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { FindUsagesTool } from '../tools/findUsagesTool';
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

vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            textDocuments: [],
            openTextDocument: vi.fn(),
            asRelativePath: vi.fn((uri) => 'src/test.ts'),
            workspaceFolders: [{
                uri: { fsPath: '/test/workspace' }
            }]
        },
        commands: {
            executeCommand: vi.fn()
        },
        Position: vi.fn().mockImplementation((line, character) => ({ line, character })),
        Range: vi.fn().mockImplementation((start, end) => ({
            start,
            end,
            contains: vi.fn(() => true)
        })),
        Uri: {
            parse: vi.fn((path) => ({ toString: () => path, fsPath: path })),
            joinPath: vi.fn((base, relative) => ({
                toString: () => `${base.fsPath}/${relative}`,
                fsPath: `${base.fsPath}/${relative}`
            }))
        }
    };
});

const mockModel = {
    countTokens: vi.fn(() => Promise.resolve(100)),
    maxInputTokens: 8000
};

const mockCopilotModelManager = {
    getCurrentModel: vi.fn(() => Promise.resolve(mockModel)),
    sendRequest: vi.fn()
};

const mockPromptGenerator = {
    getSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer.'),
    getToolInformation: vi.fn().mockReturnValue('\n\nYou have access to tools: find_usages'),
    generateToolAwareSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer with access to tools: find_usages'),
    generateToolCallingUserPrompt: vi.fn().mockReturnValue('<files_to_review>Sample diff content</files_to_review>')
};

describe('FindUsages Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let conversationManager: ConversationManager;
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let mockWorkspaceSettings: WorkspaceSettingsService;
    let findUsagesTool: FindUsagesTool;
    let tokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        // Initialize the tool-calling system
        toolRegistry = new ToolRegistry();
        mockWorkspaceSettings = createMockWorkspaceSettings();
        toolExecutor = new ToolExecutor(toolRegistry, mockWorkspaceSettings);
        conversationManager = new ConversationManager();

        // Initialize tools
        findUsagesTool = new FindUsagesTool();
        toolRegistry.registerTool(findUsagesTool);

        // Initialize orchestrator
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as any,
            mockPromptGenerator as any,
            mockWorkspaceSettings
        );

        // Clear all mocks
        vi.clearAllMocks();

        vi.mocked(vscode.CancellationTokenSource).mockImplementation(() => {
            const listeners: Array<(e: any) => any> = [];
            let isCancelled = false;

            const token: vscode.CancellationToken = {
                get isCancellationRequested() { return isCancelled; },
                onCancellationRequested: vi.fn((listener: (e: any) => any) => {
                    listeners.push(listener);
                    return {
                        dispose: vi.fn(() => {
                            const index = listeners.indexOf(listener);
                            if (index !== -1) {
                                listeners.splice(index, 1);
                            }
                        })
                    };
                })
            };

            return {
                token: token,
                cancel: vi.fn(() => {
                    isCancelled = true;
                    // Create a copy of listeners array before iteration
                    [...listeners].forEach(listener => listener(undefined)); // Pass undefined or a specific event if needed
                }),
                dispose: vi.fn()
            } as unknown as vscode.CancellationTokenSource; // Cast to assure TS it's a CancellationTokenSource
        });
        tokenSource = new vscode.CancellationTokenSource();
    });

    describe('End-to-End Find Usages Workflow', () => {
        it('should successfully find and format symbol usages', async () => {
            // Setup mock document and references
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {\n  method() {}\n}\n\nconst instance = new MyClass();'),
                uri: { toString: () => 'file:///src/test.ts', fsPath: '/src/test.ts' }
            };

            const mockReferences = [
                {
                    uri: { toString: () => 'file:///src/test.ts' },
                    range: {
                        start: { line: 4, character: 21 },
                        end: { line: 4, character: 28 }
                    }
                },
                {
                    uri: { toString: () => 'file:///src/other.ts' },
                    range: {
                        start: { line: 2, character: 10 },
                        end: { line: 2, character: 17 }
                    }
                }
            ];

            // Mock VS Code API calls
            (vscode.workspace.openTextDocument as any)
                .mockResolvedValueOnce(mockDocument)  // Initial document
                .mockResolvedValueOnce(mockDocument)  // First reference
                .mockResolvedValueOnce(mockDocument); // Second reference

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeDefinitionProvider') {
                    return Promise.resolve([{
                        uri: { toString: () => 'file:///src/test.ts' },
                        range: { contains: () => true }
                    }]);
                }
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            // Mock LLM response with tool call
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_1',
                        function: {
                            name: 'find_usages',
                            arguments: JSON.stringify({
                                symbol_name: 'MyClass',
                                file_path: 'src/test.ts',
                                context_line_count: 2
                            })
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'Based on the tool results, I found 2 usages of MyClass.',
                    toolCalls: undefined
                });

            const diff = 'diff --git a/src/test.ts b/src/test.ts\n+class MyClass {}';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result).toBe('Based on the tool results, I found 2 usages of MyClass.');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(2);

            // Verify the tool was called correctly (should be called at least once with reference provider)
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeReferenceProvider',
                expect.any(Object),
                expect.any(Object),
                { includeDeclaration: false }
            );

            // Verify conversation history includes tool results
            const history = conversationManager.getHistory();
            expect(history.length).toBeGreaterThan(2);

            // Find the tool result message
            const toolResultMessage = history.find(msg =>
                msg.role === 'tool' && msg.content?.includes('"file"')
            );
            expect(toolResultMessage).toBeDefined();
        });

        it('should handle no usages found scenario', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class UnusedClass {}'),
                uri: { toString: () => 'file:///src/test.ts', fsPath: '/src/test.ts' }
            };

            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve([]); // No references found
                }
                return Promise.resolve([]);
            });

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_1',
                        function: {
                            name: 'find_usages',
                            arguments: JSON.stringify({
                                symbol_name: 'UnusedClass',
                                file_path: 'src/test.ts'
                            })
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'No usages found for this class, it appears to be unused.',
                    toolCalls: undefined
                });

            const diff = 'diff --git a/src/test.ts b/src/test.ts\n+class UnusedClass {}';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result).toBe('No usages found for this class, it appears to be unused.');

            // Verify the "no usages" message was returned
            const history = conversationManager.getHistory();
            const toolResultMessage = history.find(msg =>
                msg.role === 'tool' && msg.content?.includes('No usages found')
            );
            expect(toolResultMessage).toBeDefined();
        });

        it('should handle multiple tool calls in sequence', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class ClassA {}\nclass ClassB {}'),
                uri: { toString: () => 'file:///src/test.ts', fsPath: '/src/test.ts' }
            };

            const mockReferencesA = [
                {
                    uri: { toString: () => 'file:///src/usage.ts' },
                    range: { start: { line: 0, character: 15 }, end: { line: 0, character: 21 } }
                }
            ];

            const mockReferencesB = [
                {
                    uri: { toString: () => 'file:///src/usage.ts' },
                    range: { start: { line: 1, character: 15 }, end: { line: 1, character: 21 } }
                }
            ];

            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            let callCount = 0;
            (vscode.commands.executeCommand as any).mockImplementation((command: string, uri: any, position: any, context: any) => {
                if (command === 'vscode.executeReferenceProvider') {
                    callCount++;
                    return Promise.resolve(callCount === 1 ? mockReferencesA : mockReferencesB);
                }
                return Promise.resolve([]);
            });

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({ symbol_name: 'ClassA', file_path: 'src/test.ts' })
                            }
                        },
                        {
                            id: 'call_2',
                            function: {
                                name: 'find_usages',
                                arguments: JSON.stringify({ symbol_name: 'ClassB', file_path: 'src/test.ts' })
                            }
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    content: 'Both classes have one usage each.',
                    toolCalls: undefined
                });

            const diff = 'diff --git a/src/test.ts b/src/test.ts\n+class ClassA {}\n+class ClassB {}';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result).toBe('Both classes have one usage each.');
            expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(4); // Two tools × (1 definition + 1 reference call each) = 4 calls

            // Verify both tool results are in conversation history
            const history = conversationManager.getHistory();
            const toolResultMessages = history.filter(msg =>
                msg.role === 'tool' && msg.content?.includes('"file"')
            );
            expect(toolResultMessages).toHaveLength(2); // Two separate tool result messages
        });

        it('should handle tool execution errors gracefully', async () => {
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_1',
                        function: {
                            name: 'find_usages',
                            arguments: JSON.stringify({
                                symbol_name: 'NonExistentClass',
                                file_path: 'nonexistent.ts'
                            })
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'I encountered an error finding usages for that symbol.',
                    toolCalls: undefined
                });

            (vscode.workspace.openTextDocument as any).mockRejectedValue(new Error('File not found'));

            const diff = 'diff --git a/src/test.ts b/src/test.ts\n+// some change';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result).toBe('I encountered an error finding usages for that symbol.');

            // Verify error message was passed to LLM
            const history = conversationManager.getHistory();
            const errorMessage = history.find(msg =>
                msg.role === 'tool' && msg.content?.includes('Error: Could not open file')
            );
            expect(errorMessage).toBeDefined();
        });

        it('should handle shouldIncludeDeclaration parameter correctly', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {}'),
                uri: { toString: () => 'file:///src/test.ts', fsPath: '/src/test.ts' }
            };

            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            let capturedContext: any;
            (vscode.commands.executeCommand as any).mockImplementation((command: string, uri: any, position: any, context: any) => {
                if (command === 'vscode.executeReferenceProvider') {
                    capturedContext = context;
                    return Promise.resolve([]);
                }
                return Promise.resolve([]);
            });

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_1',
                        function: {
                            name: 'find_usages',
                            arguments: JSON.stringify({
                                symbol_name: 'MyClass',
                                file_path: 'src/test.ts',
                                should_include_declaration: true
                            })
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'Analysis complete.',
                    toolCalls: undefined
                });

            const diff = 'diff --git a/src/test.ts b/src/test.ts\n+class MyClass {}';
            await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(capturedContext?.includeDeclaration).toBe(true);
        });

        it('should respect context_line_count parameter', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('line1\nline2\nclass MyClass {}\nline4\nline5'),
                uri: { toString: () => 'file:///src/test.ts', fsPath: '/src/test.ts' }
            };

            const mockReferences = [
                {
                    uri: { toString: () => 'file:///src/test.ts' },
                    range: { start: { line: 2, character: 6 }, end: { line: 2, character: 13 } }
                }
            ];

            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_1',
                        function: {
                            name: 'find_usages',
                            arguments: JSON.stringify({
                                symbol_name: 'MyClass',
                                file_path: 'src/test.ts',
                                context_line_count: 1
                            })
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'Found usage with context.',
                    toolCalls: undefined
                });

            const diff = 'diff --git a/src/test.ts b/src/test.ts\n+class MyClass {}';
            await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            // Verify context includes the expected lines
            const history = conversationManager.getHistory();
            const toolResultMessage = history.find(msg =>
                msg.role === 'tool' && msg.content?.includes('"context"')
            );

            expect(toolResultMessage?.content).toContain('2: line2');
            expect(toolResultMessage?.content).toContain('4: line4');
        });
    });
});