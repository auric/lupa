import * as vscode from 'vscode';
import { Log } from './loggingService';

/**
 * Service that registers and manages the Lupa chat participant for VS Code Copilot Chat.
 * Provides the `@lupa` mention capability with `/branch` and `/changes` commands.
 *
 * Implements graceful degradation: if Copilot is not installed or the Chat API
 * is unavailable, the service logs a warning and continues without crashing.
 */
export class ChatParticipantService implements vscode.Disposable {
    private static instance: ChatParticipantService | undefined;
    private participant: vscode.ChatParticipant | undefined;
    private disposables: vscode.Disposable[] = [];

    private constructor() {
        this.registerParticipant();
    }

    /**
     * Returns the singleton instance of the ChatParticipantService.
     * Creates the instance on first call, which triggers chat participant registration.
     */
    public static getInstance(): ChatParticipantService {
        if (!ChatParticipantService.instance) {
            ChatParticipantService.instance = new ChatParticipantService();
        }
        return ChatParticipantService.instance;
    }

    /**
     * Resets the singleton instance by disposing it and clearing the reference.
     * @internal Used for testing to ensure clean state between tests.
     */
    public static reset(): void {
        if (ChatParticipantService.instance) {
            ChatParticipantService.instance.dispose();
            ChatParticipantService.instance = undefined;
        }
    }

    private registerParticipant(): void {
        try {
            this.participant = vscode.chat.createChatParticipant(
                'lupa.chat-participant',
                this.handleRequest.bind(this)
            );
            if (this.participant) {
                this.disposables.push(this.participant);
            }
            Log.info('[ChatParticipantService]: Chat participant registered successfully');
        } catch (error) {
            Log.warn(
                '[ChatParticipantService]: Chat participant registration failed - Copilot may not be installed',
                error
            );
        }
    }

    private async handleRequest(
        _request: vscode.ChatRequest,
        _context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        _token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.markdown('Lupa chat participant registered. Commands coming soon!');
        return {};
    }

    /**
     * Disposes of the chat participant and all associated resources.
     * Clears the singleton instance reference.
     */
    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        ChatParticipantService.instance = undefined;
    }
}
