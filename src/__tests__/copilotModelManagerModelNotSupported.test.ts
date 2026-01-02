import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { CopilotModelManager } from '../models/copilotModelManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';

function createMockSettings(timeoutSeconds: number): WorkspaceSettingsService {
    return {
        getPreferredModelIdentifier: vi.fn().mockReturnValue(undefined),
        setPreferredModelIdentifier: vi.fn(),
        getRequestTimeoutSeconds: vi.fn().mockReturnValue(timeoutSeconds),
        getMaxIterations: () => ANALYSIS_LIMITS.maxIterations.default,
    } as unknown as WorkspaceSettingsService;
}

describe('CopilotModelManager model not supported handling', () => {
    let modelManager: CopilotModelManager;
    let mockSettings: WorkspaceSettingsService;
    let mockModel: any;
    let cancellationTokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        mockSettings = createMockSettings(5);

        mockModel = {
            id: 'unsupported-model',
            name: 'Unsupported Model',
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

    it('passes through raw model_not_supported error for ConversationRunner to handle', async () => {
        // CopilotModelManager now just delegates to ModelRequestHandler.
        // Error handling is centralized in ConversationRunner.detectFatalError()
        const unsupportedError = new Error(
            'Request Failed: 400 {"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}'
        );
        mockModel.sendRequest.mockRejectedValue(unsupportedError);

        const request = {
            messages: [{ role: 'user' as const, content: 'test' }],
            tools: [],
        };

        // The raw error should propagate - ConversationRunner will detect and handle it
        await expect(
            modelManager.sendRequest(request, cancellationTokenSource.token)
        ).rejects.toThrow('model_not_supported');
    });
});
