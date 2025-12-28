import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { ChatLLMClient } from '../models/chatLLMClient';
import { ModelRequestHandler } from '../models/modelRequestHandler';
import type { ToolCallRequest, ToolCallResponse } from '../types/modelTypes';

vi.mock('../models/modelRequestHandler', () => ({
    ModelRequestHandler: {
        sendRequest: vi.fn(),
    },
}));

describe('ChatLLMClient', () => {
    const mockModel = {
        id: 'test-model',
        name: 'Test Model',
        vendor: 'test',
        family: 'test-family',
        version: '1.0',
        maxInputTokens: 100000,
    } as unknown as vscode.LanguageModelChat;

    const mockToken: vscode.CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
    };

    const defaultTimeoutMs = 300000;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should store model and timeout', async () => {
            const client = new ChatLLMClient(mockModel, defaultTimeoutMs);
            const model = await client.getCurrentModel();
            expect(model).toBe(mockModel);
        });
    });

    describe('sendRequest', () => {
        it('should delegate to ModelRequestHandler.sendRequest with configured timeout', async () => {
            const mockResponse: ToolCallResponse = {
                content: 'Analysis complete',
                toolCalls: undefined,
            };
            vi.mocked(ModelRequestHandler.sendRequest).mockResolvedValue(
                mockResponse
            );

            const client = new ChatLLMClient(mockModel, defaultTimeoutMs);
            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'Analyze code' }],
                tools: [],
            };

            const result = await client.sendRequest(request, mockToken);

            expect(ModelRequestHandler.sendRequest).toHaveBeenCalledWith(
                mockModel,
                request,
                mockToken,
                defaultTimeoutMs
            );
            expect(result).toBe(mockResponse);
        });

        it('should pass through tool calls from response', async () => {
            const mockResponse: ToolCallResponse = {
                content: 'Calling tools',
                toolCalls: [
                    {
                        id: 'call_1',
                        function: {
                            name: 'find_symbol',
                            arguments: '{"name":"test"}',
                        },
                    },
                ],
            };
            vi.mocked(ModelRequestHandler.sendRequest).mockResolvedValue(
                mockResponse
            );

            const client = new ChatLLMClient(mockModel, defaultTimeoutMs);
            const request: ToolCallRequest = { messages: [], tools: [] };
            const result = await client.sendRequest(request, mockToken);

            expect(result.toolCalls).toEqual(mockResponse.toolCalls);
        });

        it('should propagate errors from ModelRequestHandler', async () => {
            const error = new Error('Request timed out');
            vi.mocked(ModelRequestHandler.sendRequest).mockRejectedValue(error);

            const client = new ChatLLMClient(mockModel, defaultTimeoutMs);
            const request: ToolCallRequest = { messages: [], tools: [] };

            await expect(
                client.sendRequest(request, mockToken)
            ).rejects.toThrow('Request timed out');
        });
    });

    describe('getCurrentModel', () => {
        it('should return the wrapped model', async () => {
            const client = new ChatLLMClient(mockModel, defaultTimeoutMs);
            const model = await client.getCurrentModel();

            expect(model).toBe(mockModel);
        });

        it('should return same model instance on multiple calls', async () => {
            const client = new ChatLLMClient(mockModel, defaultTimeoutMs);
            const model1 = await client.getCurrentModel();
            const model2 = await client.getCurrentModel();

            expect(model1).toBe(model2);
            expect(model1).toBe(mockModel);
        });
    });
});
