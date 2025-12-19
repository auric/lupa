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
import { PromptGenerator } from '../models/promptGenerator';
import { DiffUtils } from '../utils/diffUtils';
import { buildFileTree } from '../utils/fileTreeBuilder';
import { ACTIVITY, SEVERITY } from '../config/chatEmoji';
import { CANCELLATION_MESSAGE } from '../config/constants';
import { ChatResponseBuilder } from '../utils/chatResponseBuilder';
import type { ChatToolCallHandler, ChatAnalysisMetadata } from '../types/chatTypes';
import { createFollowupProvider } from './chatFollowupProvider';

/**
 * Dependencies required for ChatParticipantService to execute analysis commands.
 * Injected after construction via setDependencies().
 */
export interface ChatParticipantDependencies {
    toolExecutor: ToolExecutor;
    toolRegistry: ToolRegistry;
    workspaceSettings: WorkspaceSettingsService;
    promptGenerator: PromptGenerator;
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
                this.participant.followupProvider = createFollowupProvider();

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

        if (request.command === 'changes') {
            return this.handleChangesCommand(request, stream, token);
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
        return this.runGitAnalysis(
            request,
            stream,
            token,
            'Fetching branch changes...',
            () => GitService.getInstance().compareBranches({}),
            'Your branch `${refName}` appears to be up-to-date with the default branch. Nothing to analyze!',
            'branch changes'
        );
    }

    /**
     * Handle the /changes command to analyze uncommitted changes.
     */
    private async handleChangesCommand(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        return this.runGitAnalysis(
            request,
            stream,
            token,
            'Fetching uncommitted changes...',
            () => GitService.getInstance().getUncommittedChanges(),
            'You have no uncommitted changes to analyze. Your working tree is clean!',
            'uncommitted changes'
        );
    }

    /**
     * Helper to run analysis based on a git operation.
     */
    private async runGitAnalysis(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        progressMessage: string,
        gitOp: () => Promise<{ diffText: string; refName: string; error?: string }>,
        noChangesMessage: string,
        scopeLabel: string
    ): Promise<vscode.ChatResult> {
        Log.info(`[ChatParticipantService]: /${request.command} command received`);

        if (!this.deps) {
            Log.error('[ChatParticipantService]: Dependencies not injected');
            const response = new ChatResponseBuilder()
                .addErrorSection('Configuration Error', 'Lupa is still initializing. Please try again in a moment.')
                .build();
            stream.markdown(response);
            return { errorDetails: { message: 'Service not initialized' } };
        }

        try {
            stream.progress(`${ACTIVITY.reading} ${progressMessage}`);

            const gitService = GitService.getInstance();
            if (!gitService.isInitialized()) {
                const response = new ChatResponseBuilder()
                    .addErrorSection('Git Not Initialized', 'Could not find a Git repository. Please ensure you have a Git repository open.')
                    .build();
                stream.markdown(response);
                return { errorDetails: { message: 'Git service not initialized' } };
            }

            const diffResult = await gitOp();

            if (diffResult.error || !diffResult.diffText) {
                // Format message with refName if available (for branch command)
                const message = noChangesMessage.replace('${refName}', diffResult.refName || 'unknown');
                const response = new ChatResponseBuilder()
                    .addVerdictLine('success', 'No Changes Found')
                    .addFollowupPrompt(message)
                    .build();
                stream.markdown(response);
                return {};
            }

            const finalScopeLabel = request.command === 'branch' ? diffResult.refName : scopeLabel;

            return this.runAnalysis(request, stream, token, diffResult, finalScopeLabel);
        } catch (error) {
            if (token.isCancellationRequested) {
                return this.handleCancellation(stream);
            }

            const errorMessage = error instanceof Error ? error.message : String(error);
            Log.error(`[ChatParticipantService]: /${request.command} analysis failed`, error);

            const response = new ChatResponseBuilder()
                .addErrorSection('Analysis Error', 'Something went wrong during analysis. Please try again.', errorMessage)
                .build();
            stream.markdown(response);
            return {
                errorDetails: { message: errorMessage },
                metadata: { responseIsIncomplete: true }
            };
        }
    }

    /**
     * Run analysis on diff content using the LLM with tool-calling.
     */
    private async runAnalysis(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        diffResult: { diffText: string; refName: string },
        scopeLabel: string
    ): Promise<vscode.ChatResult> {
        if (token.isCancellationRequested) {
            return this.handleCancellation(stream);
        }

        Log.info(`[ChatParticipantService]: Analyzing ${scopeLabel}`);
        stream.progress(`${ACTIVITY.analyzing} Analyzing ${scopeLabel}...`);

        const timeoutMs = this.deps!.workspaceSettings.getRequestTimeoutSeconds() * 1000;
        const client = new ChatLLMClient(request.model, timeoutMs);
        const runner = new ConversationRunner(client, this.deps!.toolExecutor);
        const conversation = new ConversationManager();
        const availableTools = this.deps!.toolExecutor.getAvailableTools();
        const systemPrompt = this.deps!.promptGenerator.generateToolAwareSystemPrompt(availableTools);

        const parsedDiff = DiffUtils.parseDiff(diffResult.diffText);

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder && parsedDiff.length > 0) {
            const fileTree = buildFileTree(parsedDiff);
            stream.filetree(fileTree, workspaceFolder.uri);
        }

        const userPrompt = this.deps!.promptGenerator.generateToolCallingUserPrompt(parsedDiff);
        conversation.addUserMessage(userPrompt);

        const uiHandler: ChatToolCallHandler = {
            onProgress: (msg) => stream.progress(msg),
            onToolStart: () => { },
            onToolComplete: () => { },
            onFileReference: () => { },
            // onThinking is currently unused by ToolCallStreamAdapter but required by interface
            onThinking: (thought) => stream.progress(`${ACTIVITY.thinking} ${thought}`),
            onMarkdown: (content) => stream.markdown(content)
        };

        const debouncedHandler = new DebouncedStreamHandler(uiHandler);
        const adapter = new ToolCallStreamAdapter(debouncedHandler);

        const analysisResult = await runner.run(
            {
                systemPrompt,
                maxIterations: this.deps!.workspaceSettings.getMaxIterations(),
                tools: availableTools,
                label: `Chat /${scopeLabel}`
            },
            conversation,
            token,
            adapter
        );

        debouncedHandler.flush();

        if (analysisResult === CANCELLATION_MESSAGE) {
            return this.handleCancellation(stream);
        }

        stream.markdown(analysisResult);

        const contentAnalysis = this.analyzeResultContent(analysisResult);

        return {
            metadata: {
                command: request.command as 'branch' | 'changes',
                filesAnalyzed: parsedDiff.length,
                issuesFound: contentAnalysis.issuesFound,
                hasCriticalIssues: contentAnalysis.hasCriticalIssues,
                hasSecurityIssues: contentAnalysis.hasSecurityIssues,
                hasTestingSuggestions: contentAnalysis.hasTestingSuggestions,
                cancelled: false,
                analysisTimestamp: Date.now(),
            } satisfies ChatAnalysisMetadata,
        };
    }

    /**
     * Analyzes LLM output to detect issue types for follow-up generation.
     * Uses simple string matching—not guaranteed accurate but sufficient for UX.
     */
    private analyzeResultContent(analysisResult: string): {
        issuesFound: boolean;
        hasCriticalIssues: boolean;
        hasSecurityIssues: boolean;
        hasTestingSuggestions: boolean;
    } {
        return {
            issuesFound:
                analysisResult.includes('🔴') ||
                analysisResult.includes('🟠') ||
                analysisResult.includes('🟡'),
            hasCriticalIssues: analysisResult.includes('🔴'),
            hasSecurityIssues: analysisResult.includes('🔒'),
            hasTestingSuggestions: analysisResult.includes('🧪'),
        };
    }

    /**
     * Format a user-friendly cancellation response with correct metadata.
     */
    private handleCancellation(stream: vscode.ChatResponseStream): vscode.ChatResult {
        Log.info('[ChatParticipantService]: Analysis cancelled by user');

        const response = new ChatResponseBuilder()
            .addVerdictLine('cancelled', 'Analysis Cancelled')
            .addFollowupPrompt('Analysis was stopped before findings could be generated.\n\n*Run the command again when you\'re ready.*')
            .build();
        stream.markdown(response);

        return {
            metadata: {
                cancelled: true,
                responseIsIncomplete: true
            }
        };
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
