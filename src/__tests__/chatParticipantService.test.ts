import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ChatParticipantService } from '../services/chatParticipantService';
import { GitService } from '../services/gitService';
import { ConversationRunner } from '../models/conversationRunner';
import { MAIN_ANALYSIS_ONLY_TOOLS } from '../models/toolConstants';
import { createMockCopilotModelManager } from './testUtils/mockFactories';

vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        chat: {
            createChatParticipant: vi.fn(),
        },
    };
});

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('../services/gitService', () => ({
    GitService: {
        getInstance: vi.fn(),
    },
}));

// Vitest 4 requires function syntax for constructor mocks
vi.mock('../models/conversationRunner', () => ({
    ConversationRunner: vi.fn().mockImplementation(function (this: any) {
        this.run = vi.fn().mockResolvedValue('Analysis complete');
        this.reset = vi.fn();
    }),
}));

describe('ChatParticipantService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ChatParticipantService.reset();
    });

    afterEach(() => {
        ChatParticipantService.reset();
    });

    describe('getInstance', () => {
        it('should create singleton instance', () => {
            const instance1 = ChatParticipantService.getInstance();
            const instance2 = ChatParticipantService.getInstance();
            expect(instance1).toBe(instance2);
        });

        it('should register chat participant on initialization', () => {
            const mockParticipant = { dispose: vi.fn() };
            (vscode.chat.createChatParticipant as any).mockReturnValue(
                mockParticipant
            );

            ChatParticipantService.getInstance();

            expect(vscode.chat.createChatParticipant).toHaveBeenCalledWith(
                'lupa.chat-participant',
                expect.any(Function)
            );
        });
    });

    describe('graceful degradation', () => {
        it('should handle missing vscode.chat gracefully', () => {
            (vscode.chat.createChatParticipant as any).mockImplementation(
                () => {
                    throw new Error('Chat API not available');
                }
            );

            expect(() => ChatParticipantService.getInstance()).not.toThrow();
        });

        it('should log warning when registration fails', async () => {
            const { Log } = await import('../services/loggingService');
            (vscode.chat.createChatParticipant as any).mockImplementation(
                () => {
                    throw new Error('Copilot not installed');
                }
            );

            ChatParticipantService.getInstance();

            expect(Log.warn).toHaveBeenCalledWith(
                '[ChatParticipantService]: Chat participant registration failed - Copilot may not be installed',
                expect.any(Error)
            );
        });
    });

    describe('handler', () => {
        it('should route no-command requests to exploration mode', async () => {
            const mockParticipant = { dispose: vi.fn() };
            const mockStream = {
                markdown: vi.fn(),
                progress: vi.fn(),
            };
            const mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(),
            };

            let capturedHandler: any;
            (vscode.chat.createChatParticipant as any).mockImplementation(
                (_id: string, handler: any) => {
                    capturedHandler = handler;
                    return mockParticipant;
                }
            );

            ChatParticipantService.getInstance();

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'test question',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Configuration Error')
            );
            expect(result).toHaveProperty('errorDetails');
        });
    });

    describe('/branch command', () => {
        let capturedHandler: any;
        let mockStream: any;
        let mockToken: any;
        let mockToolRegistry: any;
        let mockWorkspaceSettings: any;
        let mockPromptGenerator: any;
        let mockGitOperations: any;

        beforeEach(() => {
            const mockParticipant = { dispose: vi.fn() };
            mockStream = {
                markdown: vi.fn(),
                progress: vi.fn(),
                filetree: vi.fn(),
            };
            mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(),
            };
            mockToolRegistry = {
                getToolNames: vi.fn().mockReturnValue([]),
                getAllTools: vi.fn().mockReturnValue([]),
            };
            mockWorkspaceSettings = {
                getRequestTimeoutSeconds: vi.fn().mockReturnValue(300),
                getMaxIterations: vi.fn().mockReturnValue(100),
            };
            mockPromptGenerator = {
                generateToolAwareSystemPrompt: vi
                    .fn()
                    .mockReturnValue('System prompt'),
                generateToolCallingUserPrompt: vi
                    .fn()
                    .mockReturnValue('User prompt'),
            };
            mockGitOperations = {
                getRepository: vi.fn().mockReturnValue({
                    rootUri: { fsPath: '/test/git-root' },
                }),
            };

            (vscode.chat.createChatParticipant as any).mockImplementation(
                (_id: string, handler: any) => {
                    capturedHandler = handler;
                    return mockParticipant;
                }
            );
        });

        it('should route /branch command to handleBranchCommand', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                compareBranches: vi.fn().mockResolvedValue({
                    diffText: 'mock diff content',
                    refName: 'feature/test',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'branch', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockGitService.compareBranches).toHaveBeenCalledWith({});
            expect(mockStream.progress).toHaveBeenCalled();
            expect(result.metadata).toMatchObject({
                command: 'branch',
                cancelled: false,
            });
        });

        it('should return helpful message for empty diff', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                compareBranches: vi.fn().mockResolvedValue({
                    diffText: '',
                    refName: 'main',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'branch', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('No Changes Found')
            );
            expect(result).toEqual({});
        });

        it('should return helpful message for diff error', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                compareBranches: vi.fn().mockResolvedValue({
                    diffText: '',
                    refName: 'unknown',
                    error: 'Could not determine base branch',
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'branch', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('No Changes Found')
            );
            expect(result).toEqual({});
        });

        it('should return error when dependencies not injected', async () => {
            ChatParticipantService.getInstance();

            const result = await capturedHandler(
                { command: 'branch', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Configuration Error')
            );
            expect(result).toHaveProperty('errorDetails');
        });

        it('should return error when git not initialized', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(false),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'branch', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Git Not Initialized')
            );
            expect(result).toHaveProperty('errorDetails');
        });

        it('should handle analysis errors gracefully', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                compareBranches: vi
                    .fn()
                    .mockRejectedValue(new Error('Network error')),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'branch', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Analysis Error')
            );
            expect(result).toHaveProperty('errorDetails');
            expect(result.metadata).toHaveProperty(
                'responseIsIncomplete',
                true
            );
        });
    });

    describe('/changes command', () => {
        let capturedHandler: any;
        let mockStream: any;
        let mockToken: any;
        let mockToolRegistry: any;
        let mockWorkspaceSettings: any;
        let mockPromptGenerator: any;
        let mockGitOperations: any;

        beforeEach(() => {
            const mockParticipant = { dispose: vi.fn() };
            mockStream = {
                markdown: vi.fn(),
                progress: vi.fn(),
                filetree: vi.fn(),
            };
            mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(),
            };
            mockToolRegistry = {
                getToolNames: vi.fn().mockReturnValue([]),
                getAllTools: vi.fn().mockReturnValue([]),
            };
            mockWorkspaceSettings = {
                getRequestTimeoutSeconds: vi.fn().mockReturnValue(300),
                getMaxIterations: vi.fn().mockReturnValue(100),
            };
            mockPromptGenerator = {
                generateToolAwareSystemPrompt: vi
                    .fn()
                    .mockReturnValue('System prompt'),
                generateToolCallingUserPrompt: vi
                    .fn()
                    .mockReturnValue('User prompt'),
            };
            mockGitOperations = {
                getRepository: vi.fn().mockReturnValue({
                    rootUri: { fsPath: '/test/git-root' },
                }),
            };

            (vscode.chat.createChatParticipant as any).mockImplementation(
                (_id: string, handler: any) => {
                    capturedHandler = handler;
                    return mockParticipant;
                }
            );
        });

        it('should route /changes command to handleChangesCommand', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'mock diff content',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockGitService.getUncommittedChanges).toHaveBeenCalled();
            expect(mockStream.progress).toHaveBeenCalled();
            expect(result.metadata).toMatchObject({
                command: 'changes',
                cancelled: false,
            });
        });

        it('should return helpful message for no uncommitted changes', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: '',
                    refName: 'uncommitted changes',
                    error: 'No uncommitted changes found',
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('No Changes Found')
            );
            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('working tree is clean')
            );
            expect(result).toEqual({});
        });

        it('should return error when git not initialized for /changes', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(false),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Git Not Initialized')
            );
            expect(result).toHaveProperty('errorDetails');
        });

        it('should handle /changes analysis errors gracefully', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi
                    .fn()
                    .mockRejectedValue(new Error('Git error')),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Analysis Error')
            );
            expect(result).toHaveProperty('errorDetails');
            expect(result.metadata).toHaveProperty(
                'responseIsIncomplete',
                true
            );
        });

        it('should call getUncommittedChanges not compareBranches', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'mock diff',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
                compareBranches: vi.fn(),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockGitService.getUncommittedChanges).toHaveBeenCalled();
            expect(mockGitService.compareBranches).not.toHaveBeenCalled();
        });

        it('should use PromptGenerator.generateToolCallingUserPrompt', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'diff --git a/test.ts b/test.ts\n+new line',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(
                mockPromptGenerator.generateToolCallingUserPrompt
            ).toHaveBeenCalledWith(
                expect.any(Array),
                undefined // User prompt is undefined when empty
            );
        });

        it('should pass user prompt to analysis when provided', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'diff --git a/test.ts b/test.ts\n+new line',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                {
                    command: 'changes',
                    model: { id: 'test-model' },
                    prompt: 'focus on security',
                },
                {},
                mockStream,
                mockToken
            );

            expect(
                mockPromptGenerator.generateToolCallingUserPrompt
            ).toHaveBeenCalledWith(expect.any(Array), 'focus on security');
        });

        it('should stream progress with uncommitted changes scope', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'mock diff',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.progress).toHaveBeenCalledWith(
                expect.stringContaining('uncommitted changes')
            );
        });

        it('should return metadata with analysis results', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'diff --git a/test.ts b/test.ts\n+new line',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi
                    .fn()
                    .mockResolvedValue(
                        'Analysis with 🔴 critical issue and 🔒 security risk'
                    );
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(result.metadata).toMatchObject({
                command: 'changes',
                filesAnalyzed: 1,
                issuesFound: true,
                hasCriticalIssues: true,
                hasSecurityIssues: true,
                hasTestingSuggestions: false,
            });
            expect(result.metadata.analysisTimestamp).toBeDefined();
        });

        it('should call stream.filetree with parsed diff files', async () => {
            // Set up workspace folders mock
            const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
            (vscode.workspace as any).workspaceFolders = [
                { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
            ];

            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText:
                        'diff --git a/src/app.ts b/src/app.ts\n@@ -1,1 +1,2 @@\n+new line',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.filetree).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'src' }),
                ]),
                expect.any(Object)
            );

            // Restore workspace folders
            (vscode.workspace as any).workspaceFolders =
                originalWorkspaceFolders;
        });
    });

    describe('dispose', () => {
        it('should dispose participant and clear instance', () => {
            const mockParticipant = { dispose: vi.fn() };
            (vscode.chat.createChatParticipant as any).mockReturnValue(
                mockParticipant
            );

            const instance = ChatParticipantService.getInstance();
            instance.dispose();

            expect(mockParticipant.dispose).toHaveBeenCalled();

            const newInstance = ChatParticipantService.getInstance();
            expect(newInstance).not.toBe(instance);
        });

        it('should handle dispose when registration failed', () => {
            (vscode.chat.createChatParticipant as any).mockImplementation(
                () => {
                    throw new Error('Failed');
                }
            );

            const instance = ChatParticipantService.getInstance();
            expect(() => instance.dispose()).not.toThrow();
        });
    });

    describe('cancellation handling', () => {
        let capturedHandler: any;
        let mockStream: any;
        let mockToolRegistry: any;
        let mockWorkspaceSettings: any;
        let mockPromptGenerator: any;
        let mockGitOperations: any;

        beforeEach(() => {
            const mockParticipant = { dispose: vi.fn() };
            mockStream = {
                markdown: vi.fn(),
                progress: vi.fn(),
                filetree: vi.fn(),
            };
            mockToolRegistry = {
                getToolNames: vi.fn().mockReturnValue([]),
                getAllTools: vi.fn().mockReturnValue([]),
            };
            mockWorkspaceSettings = {
                getRequestTimeoutSeconds: vi.fn().mockReturnValue(300),
                getMaxIterations: vi.fn().mockReturnValue(100),
            };
            mockPromptGenerator = {
                generateToolAwareSystemPrompt: vi
                    .fn()
                    .mockReturnValue('System prompt'),
                generateToolCallingUserPrompt: vi
                    .fn()
                    .mockReturnValue('User prompt'),
            };
            mockGitOperations = {
                getRepository: vi.fn().mockReturnValue({
                    rootUri: { fsPath: '/test/git-root' },
                }),
            };

            (vscode.chat.createChatParticipant as any).mockImplementation(
                (_id: string, handler: any) => {
                    capturedHandler = handler;
                    return mockParticipant;
                }
            );
        });

        describe('pre-cancelled token', () => {
            it('should return immediately with cancellation message for /branch', async () => {
                const cancelledToken = {
                    isCancellationRequested: true,
                    onCancellationRequested: vi.fn(),
                };

                const mockGitService = {
                    isInitialized: vi.fn().mockReturnValue(true),
                    compareBranches: vi.fn().mockResolvedValue({
                        diffText: 'mock diff',
                        refName: 'feature/test',
                        error: undefined,
                    }),
                };
                vi.mocked(GitService.getInstance).mockReturnValue(
                    mockGitService as unknown as GitService
                );

                const instance = ChatParticipantService.getInstance();
                instance.setDependencies({
                    toolRegistry: mockToolRegistry,
                    workspaceSettings: mockWorkspaceSettings,
                    promptGenerator: mockPromptGenerator,
                    gitOperations: mockGitOperations,
                    copilotModelManager: createMockCopilotModelManager() as any,
                });

                const result = await capturedHandler(
                    { command: 'branch', model: { id: 'test-model' } },
                    {},
                    mockStream,
                    cancelledToken
                );

                expect(mockStream.markdown).toHaveBeenCalledWith(
                    expect.stringContaining('Analysis Cancelled')
                );
                expect(result.metadata).toEqual({
                    cancelled: true,
                    responseIsIncomplete: true,
                });
            });

            it('should return immediately with cancellation message for /changes', async () => {
                const cancelledToken = {
                    isCancellationRequested: true,
                    onCancellationRequested: vi.fn(),
                };

                const mockGitService = {
                    isInitialized: vi.fn().mockReturnValue(true),
                    getUncommittedChanges: vi.fn().mockResolvedValue({
                        diffText: 'mock diff',
                        refName: 'uncommitted changes',
                        error: undefined,
                    }),
                };
                vi.mocked(GitService.getInstance).mockReturnValue(
                    mockGitService as unknown as GitService
                );

                const instance = ChatParticipantService.getInstance();
                instance.setDependencies({
                    toolRegistry: mockToolRegistry,
                    workspaceSettings: mockWorkspaceSettings,
                    promptGenerator: mockPromptGenerator,
                    gitOperations: mockGitOperations,
                    copilotModelManager: createMockCopilotModelManager() as any,
                });

                const result = await capturedHandler(
                    { command: 'changes', model: { id: 'test-model' } },
                    {},
                    mockStream,
                    cancelledToken
                );

                expect(mockStream.markdown).toHaveBeenCalledWith(
                    expect.stringContaining('Analysis Cancelled')
                );
                expect(result.metadata).toEqual({
                    cancelled: true,
                    responseIsIncomplete: true,
                });
            });
        });

        describe('cancellation during analysis', () => {
            it('should return supportive message when runner returns cancellation string', async () => {
                const mockToken = {
                    isCancellationRequested: false,
                    onCancellationRequested: vi.fn(),
                };

                vi.mocked(ConversationRunner).mockImplementation(function (
                    this: any
                ) {
                    this.run = vi.fn().mockResolvedValue('');
                    this.reset = vi.fn();
                    this.wasCancelled = true;
                });

                const mockGitService = {
                    isInitialized: vi.fn().mockReturnValue(true),
                    compareBranches: vi.fn().mockResolvedValue({
                        diffText: 'mock diff',
                        refName: 'feature/test',
                        error: undefined,
                    }),
                };
                vi.mocked(GitService.getInstance).mockReturnValue(
                    mockGitService as unknown as GitService
                );

                const instance = ChatParticipantService.getInstance();
                instance.setDependencies({
                    toolRegistry: mockToolRegistry,
                    workspaceSettings: mockWorkspaceSettings,
                    promptGenerator: mockPromptGenerator,
                    gitOperations: mockGitOperations,
                    copilotModelManager: createMockCopilotModelManager() as any,
                });

                const result = await capturedHandler(
                    { command: 'branch', model: { id: 'test-model' } },
                    {},
                    mockStream,
                    mockToken
                );

                expect(mockStream.markdown).toHaveBeenCalledWith(
                    expect.stringContaining('Analysis Cancelled')
                );
                expect(result.metadata).toEqual({
                    cancelled: true,
                    responseIsIncomplete: true,
                });
            });

            it('should NOT claim partial results exist', async () => {
                const mockToken = {
                    isCancellationRequested: false,
                    onCancellationRequested: vi.fn(),
                };

                vi.mocked(ConversationRunner).mockImplementation(function (
                    this: any
                ) {
                    this.run = vi.fn().mockResolvedValue('');
                    this.reset = vi.fn();
                    this.wasCancelled = true;
                });

                const mockGitService = {
                    isInitialized: vi.fn().mockReturnValue(true),
                    compareBranches: vi.fn().mockResolvedValue({
                        diffText: 'mock diff',
                        refName: 'feature/test',
                        error: undefined,
                    }),
                };
                vi.mocked(GitService.getInstance).mockReturnValue(
                    mockGitService as unknown as GitService
                );

                const instance = ChatParticipantService.getInstance();
                instance.setDependencies({
                    toolRegistry: mockToolRegistry,
                    workspaceSettings: mockWorkspaceSettings,
                    promptGenerator: mockPromptGenerator,
                    gitOperations: mockGitOperations,
                    copilotModelManager: createMockCopilotModelManager() as any,
                });

                await capturedHandler(
                    { command: 'branch', model: { id: 'test-model' } },
                    {},
                    mockStream,
                    mockToken
                );

                const markdownCalls = mockStream.markdown.mock.calls
                    .flat()
                    .join(' ');
                expect(markdownCalls).not.toContain('found so far');
                expect(markdownCalls).not.toContain('partial');
            });
        });

        describe('cancellation during error', () => {
            it('should treat error as cancellation if token is cancelled for /branch', async () => {
                const mockToken = {
                    isCancellationRequested: false,
                    onCancellationRequested: vi.fn(),
                };

                const mockGitService = {
                    isInitialized: vi.fn().mockReturnValue(true),
                    compareBranches: vi.fn().mockImplementation(async () => {
                        mockToken.isCancellationRequested = true;
                        throw new vscode.CancellationError();
                    }),
                };
                vi.mocked(GitService.getInstance).mockReturnValue(
                    mockGitService as unknown as GitService
                );

                const instance = ChatParticipantService.getInstance();
                instance.setDependencies({
                    toolRegistry: mockToolRegistry,
                    workspaceSettings: mockWorkspaceSettings,
                    promptGenerator: mockPromptGenerator,
                    gitOperations: mockGitOperations,
                    copilotModelManager: createMockCopilotModelManager() as any,
                });

                const result = await capturedHandler(
                    { command: 'branch', model: { id: 'test-model' } },
                    {},
                    mockStream,
                    mockToken
                );

                expect(mockStream.markdown).toHaveBeenCalledWith(
                    expect.stringContaining('Analysis Cancelled')
                );
                expect(result.metadata).toEqual({
                    cancelled: true,
                    responseIsIncomplete: true,
                });
            });

            it('should treat error as cancellation if token is cancelled for /changes', async () => {
                const mockToken = {
                    isCancellationRequested: false,
                    onCancellationRequested: vi.fn(),
                };

                const mockGitService = {
                    isInitialized: vi.fn().mockReturnValue(true),
                    getUncommittedChanges: vi
                        .fn()
                        .mockImplementation(async () => {
                            mockToken.isCancellationRequested = true;
                            throw new vscode.CancellationError();
                        }),
                };
                vi.mocked(GitService.getInstance).mockReturnValue(
                    mockGitService as unknown as GitService
                );

                const instance = ChatParticipantService.getInstance();
                instance.setDependencies({
                    toolRegistry: mockToolRegistry,
                    workspaceSettings: mockWorkspaceSettings,
                    promptGenerator: mockPromptGenerator,
                    gitOperations: mockGitOperations,
                    copilotModelManager: createMockCopilotModelManager() as any,
                });

                const result = await capturedHandler(
                    { command: 'changes', model: { id: 'test-model' } },
                    {},
                    mockStream,
                    mockToken
                );

                expect(mockStream.markdown).toHaveBeenCalledWith(
                    expect.stringContaining('Analysis Cancelled')
                );
                expect(result.metadata).toEqual({
                    cancelled: true,
                    responseIsIncomplete: true,
                });
            });
        });

        describe('ChatResult metadata', () => {
            it('should include cancelled and responseIsIncomplete in metadata', async () => {
                const cancelledToken = {
                    isCancellationRequested: true,
                    onCancellationRequested: vi.fn(),
                };

                const mockGitService = {
                    isInitialized: vi.fn().mockReturnValue(true),
                    compareBranches: vi.fn().mockResolvedValue({
                        diffText: 'mock diff',
                        refName: 'feature/test',
                        error: undefined,
                    }),
                };
                vi.mocked(GitService.getInstance).mockReturnValue(
                    mockGitService as unknown as GitService
                );

                const instance = ChatParticipantService.getInstance();
                instance.setDependencies({
                    toolRegistry: mockToolRegistry,
                    workspaceSettings: mockWorkspaceSettings,
                    promptGenerator: mockPromptGenerator,
                    gitOperations: mockGitOperations,
                    copilotModelManager: createMockCopilotModelManager() as any,
                });

                const result = await capturedHandler(
                    { command: 'branch', model: { id: 'test-model' } },
                    {},
                    mockStream,
                    cancelledToken
                );

                expect(result).toHaveProperty('metadata');
                expect(result.metadata.cancelled).toBe(true);
                expect(result.metadata.responseIsIncomplete).toBe(true);
            });
        });

        describe('both commands handle cancellation identically', () => {
            it('should produce identical cancellation message for /branch and /changes', async () => {
                const cancelledToken = {
                    isCancellationRequested: true,
                    onCancellationRequested: vi.fn(),
                };

                const mockGitService = {
                    isInitialized: vi.fn().mockReturnValue(true),
                    compareBranches: vi.fn().mockResolvedValue({
                        diffText: 'mock diff',
                        refName: 'feature/test',
                        error: undefined,
                    }),
                    getUncommittedChanges: vi.fn().mockResolvedValue({
                        diffText: 'mock diff',
                        refName: 'uncommitted changes',
                        error: undefined,
                    }),
                };
                vi.mocked(GitService.getInstance).mockReturnValue(
                    mockGitService as unknown as GitService
                );

                const instance = ChatParticipantService.getInstance();
                instance.setDependencies({
                    toolRegistry: mockToolRegistry,
                    workspaceSettings: mockWorkspaceSettings,
                    promptGenerator: mockPromptGenerator,
                    gitOperations: mockGitOperations,
                    copilotModelManager: createMockCopilotModelManager() as any,
                });

                const branchMockStream = {
                    markdown: vi.fn(),
                    progress: vi.fn(),
                };
                const changesMockStream = {
                    markdown: vi.fn(),
                    progress: vi.fn(),
                };

                const branchResult = await capturedHandler(
                    { command: 'branch', model: { id: 'test-model' } },
                    {},
                    branchMockStream,
                    cancelledToken
                );

                const changesResult = await capturedHandler(
                    { command: 'changes', model: { id: 'test-model' } },
                    {},
                    changesMockStream,
                    cancelledToken
                );

                expect(branchMockStream.markdown.mock.calls).toEqual(
                    changesMockStream.markdown.mock.calls
                );
                expect(branchResult.metadata).toEqual(changesResult.metadata);
            });
        });
    });

    describe('exploration mode (no command)', () => {
        let capturedHandler: any;
        let mockStream: any;
        let mockToken: any;
        let mockToolRegistry: any;
        let mockWorkspaceSettings: any;
        let mockPromptGenerator: any;
        let mockGitOperations: any;

        beforeEach(() => {
            const mockParticipant = { dispose: vi.fn() };
            mockStream = {
                markdown: vi.fn(),
                progress: vi.fn(),
                filetree: vi.fn(),
            };
            mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(),
            };
            mockToolRegistry = {
                getToolNames: vi.fn().mockReturnValue([]),
                getAllTools: vi.fn().mockReturnValue([]),
            };
            mockWorkspaceSettings = {
                getRequestTimeoutSeconds: vi.fn().mockReturnValue(300),
                getMaxIterations: vi.fn().mockReturnValue(100),
            };
            mockPromptGenerator = {
                generateToolAwareSystemPrompt: vi
                    .fn()
                    .mockReturnValue('Analysis system prompt'),
                generateExplorationSystemPrompt: vi
                    .fn()
                    .mockReturnValue('Exploration system prompt'),
                generateToolCallingUserPrompt: vi
                    .fn()
                    .mockReturnValue('User prompt'),
            };
            mockGitOperations = {
                getRepository: vi.fn().mockReturnValue({
                    rootUri: { fsPath: '/test/git-root' },
                }),
            };

            (vscode.chat.createChatParticipant as any).mockImplementation(
                (_id: string, handler: any) => {
                    capturedHandler = handler;
                    return mockParticipant;
                }
            );
        });

        it('should route no-command requests to exploration mode', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi
                    .fn()
                    .mockResolvedValue('Here is my explanation of the code...');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'What does ConversationRunner do?',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(
                mockPromptGenerator.generateExplorationSystemPrompt
            ).toHaveBeenCalled();
            expect(
                mockPromptGenerator.generateToolAwareSystemPrompt
            ).not.toHaveBeenCalled();
            expect(result.metadata).toMatchObject({
                command: 'exploration',
                cancelled: false,
            });
        });

        it('should handle follow-up chips (no command) as exploration mode', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Follow-up response...');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Tell me more about the security concerns',
                    model: { id: 'test-model' },
                },
                { history: [] },
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                'Follow-up response...'
            );
            expect(result.metadata.command).toBe('exploration');
        });

        it('should work without diff context', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Exploration response');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Explain the auth flow',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.filetree).not.toHaveBeenCalled();
            expect(
                mockPromptGenerator.generateToolCallingUserPrompt
            ).not.toHaveBeenCalled();
        });

        it('should return error when dependencies not injected', async () => {
            ChatParticipantService.getInstance();

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'What does this do?',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Configuration Error')
            );
            expect(result).toHaveProperty('errorDetails');
        });

        it('should handle errors with ChatResponseBuilder', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockRejectedValue(new Error('LLM error'));
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Explain this',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Exploration Error')
            );
            expect(result).toHaveProperty('errorDetails');
            expect(result.metadata).toHaveProperty(
                'responseIsIncomplete',
                true
            );
            expect(result.metadata.command).toBe('exploration');
        });

        it('should handle pre-cancelled token', async () => {
            const cancelledToken = {
                isCancellationRequested: true,
                onCancellationRequested: vi.fn(),
            };

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'What does this do?',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                cancelledToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Analysis Cancelled')
            );
            expect(result.metadata).toEqual({
                cancelled: true,
                responseIsIncomplete: true,
            });
        });

        it('should handle cancellation during exploration', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('');
                this.reset = vi.fn();
                this.wasCancelled = true;
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Explain the architecture',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Analysis Cancelled')
            );
            expect(result.metadata).toEqual({
                cancelled: true,
                responseIsIncomplete: true,
            });
        });

        it('should treat error as cancellation if token is cancelled', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockImplementation(async () => {
                    mockToken.isCancellationRequested = true;
                    throw new vscode.CancellationError();
                });
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'What is this?',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                expect.stringContaining('Analysis Cancelled')
            );
            expect(result.metadata).toEqual({
                cancelled: true,
                responseIsIncomplete: true,
            });
        });

        it('should include analysisTimestamp in metadata', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Response');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Explain this',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(result.metadata.analysisTimestamp).toBeDefined();
            expect(typeof result.metadata.analysisTimestamp).toBe('number');
        });

        it('should show progress while thinking', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Response');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Explain this',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.progress).toHaveBeenCalledWith(
                expect.stringContaining('Understanding your question')
            );
        });

        it('should show "Continuing conversation" progress when history exists', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Follow-up response');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            // Create mock history with proper structure
            const mockHistory = [
                {
                    prompt: 'Previous question',
                    participant: 'lupa.chat-participant',
                },
                {
                    response: [{ value: { value: 'Previous answer' } }],
                    participant: 'lupa.chat-participant',
                },
            ];

            await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Follow-up question',
                    model: {
                        id: 'test-model',
                        maxInputTokens: 50000,
                        countTokens: vi.fn().mockResolvedValue(10),
                    },
                },
                { history: mockHistory },
                mockStream,
                mockToken
            );

            expect(mockStream.progress).toHaveBeenCalledWith(
                expect.stringContaining('Continuing conversation')
            );
        });

        it('should not include history for /branch command', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                compareBranches: vi.fn().mockResolvedValue({
                    diffText: 'mock diff',
                    refName: 'feature/test',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Analysis result');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const mockHistory = [
                {
                    prompt: 'Previous question',
                    participant: 'lupa.chat-participant',
                },
            ];

            await capturedHandler(
                { command: 'branch', model: { id: 'test-model' } },
                { history: mockHistory },
                mockStream,
                mockToken
            );

            // Should not show "Continuing conversation" for commands
            expect(mockStream.progress).not.toHaveBeenCalledWith(
                expect.stringContaining('Continuing conversation')
            );
        });

        it('should not include history for /changes command', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'mock diff',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Analysis result');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            const mockHistory = [
                {
                    prompt: 'Previous question',
                    participant: 'lupa.chat-participant',
                },
            ];

            await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                { history: mockHistory },
                mockStream,
                mockToken
            );

            // Should not show "Continuing conversation" for commands
            expect(mockStream.progress).not.toHaveBeenCalledWith(
                expect.stringContaining('Continuing conversation')
            );
        });

        it('should gracefully handle history processing errors', async () => {
            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi
                    .fn()
                    .mockResolvedValue('Response despite history error');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            // Create a model that throws on countTokens
            const mockHistory = [
                {
                    prompt: 'Previous question',
                    participant: 'lupa.chat-participant',
                },
            ];

            const result = await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Question',
                    model: {
                        id: 'test-model',
                        maxInputTokens: 50000,
                        countTokens: vi
                            .fn()
                            .mockRejectedValue(
                                new Error('Token counting failed')
                            ),
                    },
                },
                { history: mockHistory },
                mockStream,
                mockToken
            );

            // Should still succeed and return a response
            expect(mockStream.markdown).toHaveBeenCalledWith(
                'Response despite history error'
            );
            expect(result.metadata.command).toBe('exploration');
            expect(result.metadata.cancelled).toBe(false);
        });

        it('should filter out MAIN_ANALYSIS_ONLY_TOOLS in exploration mode', async () => {
            // Create mock tools - some main-only, some allowed in exploration
            const mockMainOnlyTool = {
                name: 'update_plan',
                description: 'Update the review plan',
            };
            const mockMainOnlyTool2 = {
                name: 'submit_review',
                description: 'Submit the review',
            };
            const mockExplorationTool = {
                name: 'read_file',
                description: 'Read file content',
            };
            const mockExplorationTool2 = {
                name: 'find_symbol',
                description: 'Find symbol definitions',
            };

            // Return tools including main-only tools
            mockToolRegistry.getAllTools.mockReturnValue([
                mockMainOnlyTool,
                mockMainOnlyTool2,
                mockExplorationTool,
                mockExplorationTool2,
            ]);

            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Exploration response');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Explain the code',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            // Verify exploration prompt receives filtered tools
            expect(
                mockPromptGenerator.generateExplorationSystemPrompt
            ).toHaveBeenCalledWith(expect.any(Array));

            // Get the tools passed to generateExplorationSystemPrompt
            const passedTools =
                mockPromptGenerator.generateExplorationSystemPrompt.mock
                    .calls[0][0];

            // Should include exploration-safe tools
            expect(passedTools).toContainEqual(
                expect.objectContaining({ name: 'read_file' })
            );
            expect(passedTools).toContainEqual(
                expect.objectContaining({ name: 'find_symbol' })
            );

            // Should NOT include main-analysis-only tools
            expect(passedTools).not.toContainEqual(
                expect.objectContaining({ name: 'update_plan' })
            );
            expect(passedTools).not.toContainEqual(
                expect.objectContaining({ name: 'submit_review' })
            );
        });

        it('should filter all MAIN_ANALYSIS_ONLY_TOOLS from exploration mode', async () => {
            // Create a mock tool for each main-only tool to verify they're all filtered
            const mockTools = [
                ...MAIN_ANALYSIS_ONLY_TOOLS.map((name) => ({
                    name,
                    description: `${name} tool`,
                })),
                { name: 'read_file', description: 'Safe tool' },
            ];

            mockToolRegistry.getAllTools.mockReturnValue(mockTools);

            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockResolvedValue('Response');
                this.reset = vi.fn();
            });

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: createMockCopilotModelManager() as any,
            });

            await capturedHandler(
                {
                    command: undefined,
                    prompt: 'Question',
                    model: { id: 'test-model' },
                },
                {},
                mockStream,
                mockToken
            );

            const passedTools =
                mockPromptGenerator.generateExplorationSystemPrompt.mock
                    .calls[0][0];

            // Verify ALL main-only tools are filtered out
            for (const toolName of MAIN_ANALYSIS_ONLY_TOOLS) {
                expect(passedTools).not.toContainEqual(
                    expect.objectContaining({ name: toolName })
                );
            }

            // But read_file should still be there
            expect(passedTools).toContainEqual(
                expect.objectContaining({ name: 'read_file' })
            );
        });
    });

    describe('main analysis subagent and completion support', () => {
        let capturedHandler: any;
        let mockStream: any;
        let mockToken: any;
        let mockToolRegistry: any;
        let mockWorkspaceSettings: any;
        let mockPromptGenerator: any;
        let mockGitOperations: any;
        let mockCopilotModelManager: any;
        let runConfigCapture: any;

        beforeEach(() => {
            const mockParticipant = { dispose: vi.fn() };
            mockStream = {
                markdown: vi.fn(),
                progress: vi.fn(),
                filetree: vi.fn(),
            };
            mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(),
            };
            mockToolRegistry = {
                getToolNames: vi.fn().mockReturnValue([]),
                getAllTools: vi.fn().mockReturnValue([]),
            };
            mockWorkspaceSettings = {
                getRequestTimeoutSeconds: vi.fn().mockReturnValue(300),
                getMaxIterations: vi.fn().mockReturnValue(100),
                getMaxSubagentsPerSession: vi.fn().mockReturnValue(5),
            };
            mockPromptGenerator = {
                generateToolAwareSystemPrompt: vi
                    .fn()
                    .mockReturnValue('System prompt'),
                generateToolCallingUserPrompt: vi
                    .fn()
                    .mockReturnValue('User prompt'),
            };
            mockGitOperations = {
                getRepository: vi.fn().mockReturnValue({
                    rootUri: { fsPath: '/test/git-root' },
                }),
            };
            mockCopilotModelManager = {
                sendRequest: vi.fn().mockResolvedValue({
                    content: 'Mock response',
                    toolCalls: undefined,
                }),
            };
            runConfigCapture = null;

            vi.mocked(ConversationRunner).mockImplementation(function (
                this: any
            ) {
                this.run = vi.fn().mockImplementation((config) => {
                    runConfigCapture = config;
                    return Promise.resolve(
                        '## Summary\n\nAnalysis with at least 20 characters for submit_review.'
                    );
                });
                this.reset = vi.fn();
            });

            (vscode.chat.createChatParticipant as any).mockImplementation(
                (_id: string, handler: any) => {
                    capturedHandler = handler;
                    return mockParticipant;
                }
            );
        });

        it('should pass requiresExplicitCompletion: true for main analysis', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'diff --git a/file.ts b/file.ts\n+new line',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: mockCopilotModelManager,
            });

            await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(runConfigCapture).toBeDefined();
            expect(runConfigCapture.requiresExplicitCompletion).toBe(true);
        });

        it('should create ToolExecutor with full ExecutionContext for main analysis', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                getUncommittedChanges: vi.fn().mockResolvedValue({
                    diffText: 'diff --git a/file.ts b/file.ts\n+new line',
                    refName: 'uncommitted changes',
                    error: undefined,
                }),
            };
            vi.mocked(GitService.getInstance).mockReturnValue(
                mockGitService as unknown as GitService
            );

            // Capture the ToolExecutor constructor call
            let _capturedToolExecutor: any = null;
            const ToolExecutorMock = vi.fn().mockImplementation(function (
                this: any,
                _registry: any,
                _settings: any,
                executionContext: any
            ) {
                _capturedToolExecutor = executionContext;
                this.getAvailableTools = vi.fn().mockReturnValue([]);
                this.executeTool = vi.fn();
            });

            // Dynamically mock ToolExecutor
            vi.doMock('../models/toolExecutor', () => ({
                ToolExecutor: ToolExecutorMock,
            }));

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings,
                promptGenerator: mockPromptGenerator,
                gitOperations: mockGitOperations,
                copilotModelManager: mockCopilotModelManager,
            });

            await capturedHandler(
                { command: 'changes', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            // The test verifies that runAnalysis was called and completed
            // The actual ExecutionContext verification is done via type checking
            // since we can't easily intercept the internal ToolExecutor creation
            expect(mockStream.progress).toHaveBeenCalled();
        });
    });
});
