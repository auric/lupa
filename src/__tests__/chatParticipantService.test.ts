import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ChatParticipantService } from '../services/chatParticipantService';

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
