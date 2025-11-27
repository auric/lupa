import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { CopilotModelManager } from '../models/copilotModelManager';
import { TokenConstants } from '../models/tokenConstants';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';

describe('CopilotModelManager timeout', () => {
    let modelManager: CopilotModelManager;
    let mockWorkspaceSettingsService: WorkspaceSettingsService;
    let mockModel: any;
    let cancellationTokenSource: vscode.CancellationTokenSource;

    // Store original timeout value to restore later
    const originalTimeout = TokenConstants.LLM_REQUEST_TIMEOUT_MS;

    beforeEach(() => {
        // Use a very short timeout for tests (100ms instead of 60s)
        (TokenConstants as any).LLM_REQUEST_TIMEOUT_MS = 100;

        mockWorkspaceSettingsService = {
            getPreferredModelFamily: vi.fn().mockReturnValue(null),
            getPreferredModelVersion: vi.fn().mockReturnValue(null),
            setPreferredModelFamily: vi.fn(),
            setPreferredModelVersion: vi.fn(),
        } as unknown as WorkspaceSettingsService;

        mockModel = {
            id: 'test-model',
            name: 'Test Model',
            family: 'test-family',
            version: '1.0',
            maxInputTokens: 4096,
            sendRequest: vi.fn(),
            countTokens: vi.fn().mockResolvedValue(10),
        };

        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([mockModel]);

        modelManager = new CopilotModelManager(mockWorkspaceSettingsService);
        cancellationTokenSource = new vscode.CancellationTokenSource();
    });

    afterEach(() => {
        // Restore original timeout
        (TokenConstants as any).LLM_REQUEST_TIMEOUT_MS = originalTimeout;
        vi.clearAllMocks();
    });

    it('should timeout after configured duration', async () => {
        // Mock a request that never resolves
        mockModel.sendRequest.mockImplementation(() => new Promise(() => { }));

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: []
        };

        await expect(
            modelManager.sendRequest(request, cancellationTokenSource.token)
        ).rejects.toThrow('LLM request timed out after');
    }, 1000); // Test timeout of 1 second

    it('should complete normally if response is fast', async () => {
        const mockStream = {
            async *[Symbol.asyncIterator]() {
                yield new vscode.LanguageModelTextPart('Hello, world!');
            }
        };

        mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: []
        };

        const response = await modelManager.sendRequest(request, cancellationTokenSource.token);
        expect(response.content).toBe('Hello, world!');
    });

    it('should complete before timeout when response arrives in time', async () => {
        const mockStream = {
            async *[Symbol.asyncIterator]() {
                yield new vscode.LanguageModelTextPart('Success!');
            }
        };

        // Mock request that resolves after 20ms (well before 100ms timeout)
        mockModel.sendRequest.mockImplementation(() =>
            new Promise(resolve => setTimeout(() => resolve({ stream: mockStream }), 20))
        );

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: []
        };

        const response = await modelManager.sendRequest(request, cancellationTokenSource.token);
        expect(response.content).toBe('Success!');
    }, 1000);

    it('should propagate errors from the model', async () => {
        mockModel.sendRequest.mockRejectedValue(new Error('Model error'));

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: []
        };

        await expect(
            modelManager.sendRequest(request, cancellationTokenSource.token)
        ).rejects.toThrow('Model error');
    });

    it('should include helpful message in timeout error', async () => {
        mockModel.sendRequest.mockImplementation(() => new Promise(() => { }));

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: []
        };

        await expect(
            modelManager.sendRequest(request, cancellationTokenSource.token)
        ).rejects.toThrow('The model may be overloaded. Please try again.');
    }, 1000);
});
