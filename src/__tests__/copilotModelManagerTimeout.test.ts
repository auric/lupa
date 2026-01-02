import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { CopilotModelManager } from '../models/copilotModelManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';

/**
 * Create a mock WorkspaceSettingsService for testing with a specific timeout
 */
function createMockSettings(timeoutSeconds: number): WorkspaceSettingsService {
    return {
        getPreferredModelIdentifier: vi.fn().mockReturnValue(undefined),
        setPreferredModelIdentifier: vi.fn(),
        getRequestTimeoutSeconds: vi.fn().mockReturnValue(timeoutSeconds),
        getMaxIterations: () => ANALYSIS_LIMITS.maxIterations.default,
    } as unknown as WorkspaceSettingsService;
}

describe('CopilotModelManager timeout', () => {
    let modelManager: CopilotModelManager;
    let mockSettings: WorkspaceSettingsService;
    let mockModel: any;
    let cancellationTokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        // Use a very short timeout for tests (100ms = 0.1s instead of 60s)
        mockSettings = createMockSettings(0.1);

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

        modelManager = new CopilotModelManager(mockSettings);
        cancellationTokenSource = new vscode.CancellationTokenSource();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should timeout after configured duration', async () => {
        // Mock a request that never resolves
        mockModel.sendRequest.mockImplementation(() => new Promise(() => {}));

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: [],
        };

        await expect(
            modelManager.sendRequest(request, cancellationTokenSource.token)
        ).rejects.toThrow('LLM request timed out after');
    }, 1000); // Test timeout of 1 second

    it('should complete normally if response is fast', async () => {
        const mockStream = {
            async *[Symbol.asyncIterator]() {
                yield new vscode.LanguageModelTextPart('Hello, world!');
            },
        };

        mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: [],
        };

        const response = await modelManager.sendRequest(
            request,
            cancellationTokenSource.token
        );
        expect(response.content).toBe('Hello, world!');
    });

    it('should complete before timeout when response arrives in time', async () => {
        const mockStream = {
            async *[Symbol.asyncIterator]() {
                yield new vscode.LanguageModelTextPart('Success!');
            },
        };

        // Mock request that resolves after 20ms (well before 100ms timeout)
        mockModel.sendRequest.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve({ stream: mockStream }), 20)
                )
        );

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: [],
        };

        const response = await modelManager.sendRequest(
            request,
            cancellationTokenSource.token
        );
        expect(response.content).toBe('Success!');
    }, 1000);

    it('should propagate errors from the model', async () => {
        mockModel.sendRequest.mockRejectedValue(new Error('Model error'));

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: [],
        };

        await expect(
            modelManager.sendRequest(request, cancellationTokenSource.token)
        ).rejects.toThrow('Model error');
    });

    it('should include helpful message in timeout error', async () => {
        mockModel.sendRequest.mockImplementation(() => new Promise(() => {}));

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: [],
        };

        await expect(
            modelManager.sendRequest(request, cancellationTokenSource.token)
        ).rejects.toThrow('The model may be overloaded. Please try again.');
    }, 1000);
});
