import * as vscode from 'vscode';
import { Log } from './loggingService';
import { GitService } from './gitService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { ConversationRunner } from '../models/conversationRunner';
import { ConversationManager } from '../models/conversationManager';
import { ChatLLMClient } from '../models/chatLLMClient';
import { ToolCallStreamAdapter } from '../models/toolCallStreamAdapter';
import { DebouncedStreamHandler } from '../models/debouncedStreamHandler';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { ACTIVITY, SEVERITY } from '../config/chatEmoji';
import type { ChatToolCallHandler } from '../types/chatTypes';

/**
 * Dependencies required for ChatParticipantService to execute analysis commands.
 * Injected after construction via setDependencies().
 */
export interface ChatParticipantDependencies {
    toolExecutor: ToolExecutor;
    toolRegistry: ToolRegistry;
    workspaceSettings: WorkspaceSettingsService;
}

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
    private deps: ChatParticipantDependencies | undefined;

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

    /**
     * Inject dependencies required for analysis commands.
     * Called by ServiceManager after all services are initialized.
     */
    public setDependencies(deps: ChatParticipantDependencies): void {
        this.deps = deps;
        Log.info('[ChatParticipantService]: Dependencies injected');
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
        request: vscode.ChatRequest,
        _context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        if (request.command === 'branch') {
            return this.handleBranchCommand(request, stream, token);
        }

        stream.markdown('Lupa chat participant registered. Commands coming soon!');
        return {};
    }

    /**
     * Handle the /branch command to analyze current branch changes.
     */
    private async handleBranchCommand(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        Log.info('[ChatParticipantService]: /branch command received');

        if (!this.deps) {
            Log.error('[ChatParticipantService]: Dependencies not injected');
            stream.markdown(`## ${SEVERITY.warning} Configuration Error\n\nLupa is still initializing. Please try again in a moment.`);
            return { errorDetails: { message: 'Service not initialized' } };
        }

        try {
            stream.progress(`${ACTIVITY.reading} Fetching branch changes...`);

            const gitService = GitService.getInstance();
            if (!gitService.isInitialized()) {
                stream.markdown(`## ${SEVERITY.warning} Git Not Initialized\n\nCould not find a Git repository. Please ensure you have a Git repository open.`);
                return { errorDetails: { message: 'Git service not initialized' } };
            }

            const diffResult = await gitService.compareBranches({});

            if (diffResult.error || !diffResult.diffText) {
                stream.markdown(`## ${SEVERITY.success} No Changes Found\n\nYour branch \`${diffResult.refName}\` appears to be up-to-date with the default branch. Nothing to analyze!`);
                return {};
            }

            Log.info(`[ChatParticipantService]: Analyzing branch "${diffResult.refName}"`);
            stream.progress(`${ACTIVITY.analyzing} Analyzing ${diffResult.refName}...`);

            const timeoutMs = this.deps.workspaceSettings.getRequestTimeoutSeconds() * 1000;
            const client = new ChatLLMClient(request.model, timeoutMs);
            const runner = new ConversationRunner(client, this.deps.toolExecutor);
            const conversation = new ConversationManager();
            const availableTools = this.deps.toolExecutor.getAvailableTools();
            const promptGenerator = new ToolAwareSystemPromptGenerator();
            const systemPrompt = promptGenerator.generateSystemPrompt(availableTools);

            const userPrompt = this.buildUserPrompt(diffResult.diffText, diffResult.refName);
            conversation.addUserMessage(userPrompt);

            const uiHandler: ChatToolCallHandler = {
                onProgress: (msg) => stream.progress(msg),
                onToolStart: () => { },
                onToolComplete: () => { },
                onFileReference: () => { },
                onThinking: (thought) => stream.progress(`${ACTIVITY.thinking} ${thought}`),
                onMarkdown: (content) => stream.markdown(content)
            };

            const debouncedHandler = new DebouncedStreamHandler(uiHandler);
            const adapter = new ToolCallStreamAdapter(debouncedHandler);

            const analysisResult = await runner.run(
                {
                    systemPrompt,
                    maxIterations: 15,
                    tools: availableTools,
                    label: 'Chat /branch'
                },
                conversation,
                token,
                adapter
            );

            debouncedHandler.flush();
            stream.markdown(analysisResult);

            return {};
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Log.error('[ChatParticipantService]: /branch analysis failed', error);

            stream.markdown(`## ${SEVERITY.warning} Analysis Error\n\nSomething went wrong during analysis. Please try again.\n\n\`\`\`\n${errorMessage}\n\`\`\``);
            return {
                errorDetails: { message: errorMessage },
                metadata: { responseIsIncomplete: true }
            };
        }
    }

    private buildUserPrompt(diffText: string, branchName: string): string {
        return `Please analyze the following changes on branch \`${branchName}\`:

\`\`\`diff
${diffText}
\`\`\`

Provide a comprehensive code review focusing on:
1. Potential bugs or logic errors
2. Security vulnerabilities
3. Performance concerns
4. Code quality and maintainability
5. Test coverage considerations`;
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
