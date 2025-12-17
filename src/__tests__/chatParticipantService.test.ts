import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ChatParticipantService } from '../services/chatParticipantService';
import { GitService } from '../services/gitService';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { ConversationRunner } from '../models/conversationRunner';

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
        getInstance: vi.fn()
    }
}));

vi.mock('../models/conversationRunner', () => ({
    ConversationRunner: vi.fn().mockImplementation(() => ({
        run: vi.fn().mockResolvedValue('Analysis complete'),
        reset: vi.fn()
    }))
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
            (vscode.chat.createChatParticipant as any).mockReturnValue(mockParticipant);

            ChatParticipantService.getInstance();

            expect(vscode.chat.createChatParticipant).toHaveBeenCalledWith(
                'lupa.chat-participant',
                expect.any(Function)
            );
        });
    });

    describe('graceful degradation', () => {
        it('should handle missing vscode.chat gracefully', () => {
            (vscode.chat.createChatParticipant as any).mockImplementation(() => {
                throw new Error('Chat API not available');
            });

            expect(() => ChatParticipantService.getInstance()).not.toThrow();
        });

        it('should log warning when registration fails', async () => {
            const { Log } = await import('../services/loggingService');
            (vscode.chat.createChatParticipant as any).mockImplementation(() => {
                throw new Error('Copilot not installed');
            });

            ChatParticipantService.getInstance();

            expect(Log.warn).toHaveBeenCalledWith(
                '[ChatParticipantService]: Chat participant registration failed - Copilot may not be installed',
                expect.any(Error)
            );
        });
    });

    describe('handler', () => {
        it('should return valid ChatResult with placeholder message', async () => {
            const mockParticipant = { dispose: vi.fn() };
            const mockStream = {
                markdown: vi.fn(),
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
                { command: undefined },
                {},
                mockStream,
                mockToken
            );

            expect(mockStream.markdown).toHaveBeenCalledWith(
                'Lupa chat participant registered. Commands coming soon!'
            );
            expect(result).toEqual({});
        });
    });

    describe('/branch command', () => {
        let capturedHandler: any;
        let mockStream: any;
        let mockToken: any;
        let mockToolExecutor: any;
        let mockToolRegistry: any;
        let mockWorkspaceSettings: any;

        beforeEach(() => {
            const mockParticipant = { dispose: vi.fn() };
            mockStream = {
                markdown: vi.fn(),
                progress: vi.fn()
            };
            mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn()
            };
            mockToolExecutor = {
                getAvailableTools: vi.fn().mockReturnValue([]),
                resetToolCallCount: vi.fn()
            };
            mockToolRegistry = {
                getToolNames: vi.fn().mockReturnValue([])
            };
            mockWorkspaceSettings = {
                getRequestTimeoutSeconds: vi.fn().mockReturnValue(300)
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
                    error: undefined
                })
            };
            vi.mocked(GitService.getInstance).mockReturnValue(mockGitService as unknown as GitService);

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolExecutor: mockToolExecutor,
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings
            });

            const result = await capturedHandler(
                { command: 'branch', model: { id: 'test-model' } },
                {},
                mockStream,
                mockToken
            );

            expect(mockGitService.compareBranches).toHaveBeenCalledWith({});
            expect(mockStream.progress).toHaveBeenCalled();
            expect(result).toEqual({});
        });

        it('should return helpful message for empty diff', async () => {
            const mockGitService = {
                isInitialized: vi.fn().mockReturnValue(true),
                compareBranches: vi.fn().mockResolvedValue({
                    diffText: '',
                    refName: 'main',
                    error: undefined
                })
            };
            vi.mocked(GitService.getInstance).mockReturnValue(mockGitService as unknown as GitService);

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolExecutor: mockToolExecutor,
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings
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
                    error: 'Could not determine base branch'
                })
            };
            vi.mocked(GitService.getInstance).mockReturnValue(mockGitService as unknown as GitService);

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolExecutor: mockToolExecutor,
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings
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
                isInitialized: vi.fn().mockReturnValue(false)
            };
            vi.mocked(GitService.getInstance).mockReturnValue(mockGitService as unknown as GitService);

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolExecutor: mockToolExecutor,
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings
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
                compareBranches: vi.fn().mockRejectedValue(new Error('Network error'))
            };
            vi.mocked(GitService.getInstance).mockReturnValue(mockGitService as unknown as GitService);

            const instance = ChatParticipantService.getInstance();
            instance.setDependencies({
                toolExecutor: mockToolExecutor,
                toolRegistry: mockToolRegistry,
                workspaceSettings: mockWorkspaceSettings
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
            expect(result.metadata).toHaveProperty('responseIsIncomplete', true);
        });
    });

    describe('dispose', () => {
        it('should dispose participant and clear instance', () => {
            const mockParticipant = { dispose: vi.fn() };
            (vscode.chat.createChatParticipant as any).mockReturnValue(mockParticipant);

            const instance = ChatParticipantService.getInstance();
            instance.dispose();

            expect(mockParticipant.dispose).toHaveBeenCalled();

            const newInstance = ChatParticipantService.getInstance();
            expect(newInstance).not.toBe(instance);
        });

        it('should handle dispose when registration failed', () => {
            (vscode.chat.createChatParticipant as any).mockImplementation(() => {
                throw new Error('Failed');
            });

            const instance = ChatParticipantService.getInstance();
            expect(() => instance.dispose()).not.toThrow();
        });
    });
});
