import * as path from 'path';
import * as vscode from 'vscode';
import { Log } from './loggingService';
import { GitService } from './gitService';
import { GitOperationsManager } from './gitOperationsManager';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { ConversationRunner } from '../models/conversationRunner';
import { ConversationManager } from '../models/conversationManager';
import { ChatLLMClient } from '../models/chatLLMClient';
import type { ILLMClient } from '../models/ILLMClient';
import { ToolCallStreamAdapter } from '../models/toolCallStreamAdapter';
import { DebouncedStreamHandler } from '../models/debouncedStreamHandler';
import { ChatContextManager } from '../models/chatContextManager';
import { PromptGenerator } from '../models/promptGenerator';
import { SubagentSessionManager } from './subagentSessionManager';
import { SubagentExecutor } from './subagentExecutor';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';

import { MAIN_ANALYSIS_ONLY_TOOLS } from '../models/toolConstants';
import type { DiffEnricher } from './diffEnricher';
import type { FindingValidator } from './findingValidator';
import { formatSelfReflectionScoresMarkdown } from './selfReflectionScorer';
import { DiffUtils } from '../utils/diffUtils';
import { buildFileTree } from '../utils/fileTreeBuilder';
import { streamMarkdownWithAnchors } from '../utils/chatMarkdownStreamer';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { ACTIVITY, SEVERITY } from '../config/chatEmoji';
import { ChatResponseBuilder } from '../utils/chatResponseBuilder';
import type {
    ChatToolCallHandler,
    ChatAnalysisMetadata,
} from '../types/chatTypes';
import type { ExecutionContext } from '../types/executionContext';
import { getCalibrationProfile } from '../models/modelCalibration';

import { createFollowupProvider } from './chatFollowupProvider';
import {
    AnalysisEngine,
    type AnalysisEngineInput,
    type AnalysisEngineOutput,
} from './analysisEngine';

/**
 * Dependencies required for ChatParticipantService to execute analysis commands.
 * Injected after construction via setDependencies().
 */
export interface ChatParticipantDependencies {
    toolRegistry: ToolRegistry;
    workspaceSettings: WorkspaceSettingsService;
    promptGenerator: PromptGenerator;
    gitOperations: GitOperationsManager;
    diffEnricher: DiffEnricher;
    findingValidator: FindingValidator;
    analysisEngine: AnalysisEngine;
}

/**
 * Creates a ChatToolCallHandler that bridges ConversationRunner events to ChatResponseStream.
 * Extracted for DRY usage across exploration and analysis modes.
 *
 * Key UX features:
 * - `onProgress`: Shows spinner with progress text
 * - `onFileReference`: Creates clickable file anchors for file-based tools
 * - `onMarkdown`: Streams rich markdown content
 *
 * @param stream The VS Code chat response stream for output
 * @param gitRootUri Optional Git repository root for resolving file paths
 * @returns ChatToolCallHandler implementation
 */
function createChatStreamHandler(
    stream: vscode.ChatResponseStream,
    gitRootUri?: vscode.Uri
): ChatToolCallHandler {
    return {
        onProgress: (msg) => stream.progress(msg),
        onToolStart: () => {},
        onToolComplete: () => {},
        onFileReference: (filePath, range) => {
            // Resolve relative paths to absolute URIs
            let fileUri: vscode.Uri;
            if (path.isAbsolute(filePath)) {
                fileUri = vscode.Uri.file(filePath);
            } else if (gitRootUri) {
                fileUri = vscode.Uri.joinPath(gitRootUri, filePath);
            } else {
                // Can't resolve relative path without git root - skip anchor
                return;
            }

            // Create clickable anchor with optional line range
            if (range) {
                stream.anchor(new vscode.Location(fileUri, range), filePath);
            } else {
                stream.anchor(fileUri, filePath);
            }
        },
        onThinking: (thought) =>
            stream.progress(`${ACTIVITY.thinking} ${thought}`),
        onMarkdown: (content) => stream.markdown(content),
    };
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
            Log.info(
                '[ChatParticipantService]: Chat participant registered successfully'
            );
        } catch (error) {
            Log.warn(
                '[ChatParticipantService]: Chat participant registration failed - Copilot may not be installed',
                error
            );
        }
    }

    private async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const model = request.model;
        Log.info(
            `Using model: ${model.name} (${model.vendor}/${model.id}, ${model.maxInputTokens} tokens)`
        );
        if (request.command === 'branch') {
            return this.handleBranchCommand(request, stream, token);
        }

        if (request.command === 'changes') {
            return this.handleChangesCommand(request, stream, token);
        }

        return this.handleExplorationMode(request, context, stream, token);
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
     * Handle exploration mode for answering questions about the codebase.
     * Triggered when no slash command is provided (e.g., follow-up chips).
     * Includes conversation history for contextual follow-ups.
     */
    private async handleExplorationMode(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        Log.info('[ChatParticipantService]: Exploration mode activated');

        if (!this.deps) {
            Log.error('[ChatParticipantService]: Dependencies not injected');
            const response = new ChatResponseBuilder()
                .addErrorSection(
                    'Configuration Error',
                    'Lupa is still initializing. Please try again in a moment.'
                )
                .build();
            stream.markdown(response);
            return { errorDetails: { message: 'Service not initialized' } };
        }

        if (token.isCancellationRequested) {
            return this.handleCancellation(stream);
        }

        try {
            // Create stream adapter first - needed for subagent tool streaming
            const gitRootUri = this.deps.gitOperations.getRepository()?.rootUri;
            const { debouncedHandler, adapter } = this.createStreamAdapter(
                stream,
                gitRootUri
            );

            // Create per-request subagent infrastructure with chat handler
            const timeoutMs =
                this.deps.workspaceSettings.getRequestTimeoutSeconds() * 1000;
            const client = new ChatLLMClient(request.model, timeoutMs);
            const { subagentSessionManager, subagentExecutor } =
                this.createSubagentContext(token, client, debouncedHandler);

            // Create per-request ToolExecutor with subagent context
            const explorationProfile = getCalibrationProfile(
                request.model.family,
                request.model.id
            );
            const explorationContext: ExecutionContext = {
                subagentSessionManager,
                subagentExecutor,
                cancellationToken: token,
                calibrationProfile: explorationProfile,
                toolCallCounts: new Map(),
            };
            const toolExecutor = new ToolExecutor(
                this.deps.toolRegistry,
                explorationContext
            );
            toolExecutor.bindToContext();
            explorationContext.toolExecutor = toolExecutor;

            const runner = new ConversationRunner(client, toolExecutor);
            const conversation = new ConversationManager();

            // Filter out main-analysis-only tools for exploration mode
            // These tools require PR context, planManager, or are semantically invalid
            const allTools = toolExecutor.getAvailableTools();
            const availableTools = allTools.filter(
                (tool) =>
                    !MAIN_ANALYSIS_ONLY_TOOLS.includes(
                        tool.name as (typeof MAIN_ANALYSIS_ONLY_TOOLS)[number]
                    )
            );

            const systemPrompt =
                this.deps.promptGenerator.generateExplorationSystemPrompt();

            const hasHistory = context.history && context.history.length > 0;
            if (hasHistory) {
                stream.progress(
                    `${ACTIVITY.thinking} Continuing conversation...`
                );
                try {
                    const contextManager = new ChatContextManager();
                    const historyMessages =
                        await contextManager.prepareConversationHistory(
                            context.history,
                            request.model,
                            systemPrompt,
                            token
                        );
                    if (historyMessages.length > 0) {
                        conversation.prependHistoryMessages(historyMessages);
                    }
                } catch (error) {
                    Log.warn(
                        '[ChatParticipantService]: History processing failed, continuing without',
                        error
                    );
                }
            } else {
                stream.progress(
                    `${ACTIVITY.thinking} Understanding your question...`
                );
            }

            conversation.addUserMessage(request.prompt);

            const result = await runner.run(
                {
                    systemPrompt,
                    maxIterations:
                        this.deps.workspaceSettings.getMaxIterations(),
                    tools: availableTools,
                    label: 'Chat exploration',
                },
                conversation,
                token,
                adapter
            );

            debouncedHandler.flush();

            if (runner.wasCancelled) {
                return this.handleCancellation(stream);
            }

            streamMarkdownWithAnchors(stream, result, gitRootUri);

            return {
                metadata: {
                    command: 'exploration',
                    cancelled: false,
                    analysisTimestamp: Date.now(),
                } satisfies ChatAnalysisMetadata,
            };
        } catch (error) {
            // Check error type rather than token state to avoid race conditions
            // where the error is already thrown before we can check the token
            if (isCancellationError(error)) {
                return this.handleCancellation(stream);
            }

            const errorMessage = getErrorMessage(error);
            Log.error(
                '[ChatParticipantService]: Exploration mode failed',
                error
            );

            const response = new ChatResponseBuilder()
                .addErrorSection(
                    'Exploration Error',
                    'Something went wrong while exploring. Please try again.',
                    errorMessage
                )
                .build();
            stream.markdown(response);

            return {
                errorDetails: { message: errorMessage },
                metadata: {
                    command: 'exploration',
                    cancelled: false,
                    responseIsIncomplete: true,
                },
            };
        }
    }

    /**
     * Helper to run analysis based on a git operation.
     */
    private async runGitAnalysis(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        progressMessage: string,
        gitOp: () => Promise<{
            diffText: string;
            refName: string;
            error?: string;
        }>,
        noChangesMessage: string,
        scopeLabel: string
    ): Promise<vscode.ChatResult> {
        Log.info(
            `[ChatParticipantService]: /${request.command} command received`
        );

        if (!this.deps) {
            Log.error('[ChatParticipantService]: Dependencies not injected');
            const response = new ChatResponseBuilder()
                .addErrorSection(
                    'Configuration Error',
                    'Lupa is still initializing. Please try again in a moment.'
                )
                .build();
            stream.markdown(response);
            return { errorDetails: { message: 'Service not initialized' } };
        }

        try {
            stream.progress(`${ACTIVITY.reading} ${progressMessage}`);

            const gitService = GitService.getInstance();
            if (!gitService.isInitialized()) {
                const response = new ChatResponseBuilder()
                    .addErrorSection(
                        'Git Not Initialized',
                        'Could not find a Git repository. Please ensure you have a Git repository open.'
                    )
                    .build();
                stream.markdown(response);
                return {
                    errorDetails: { message: 'Git service not initialized' },
                };
            }

            const diffResult = await gitOp();

            if (diffResult.error || !diffResult.diffText) {
                // Format message with refName if available (for branch command)
                const message = noChangesMessage.replace(
                    '${refName}',
                    diffResult.refName || 'unknown'
                );
                const response = new ChatResponseBuilder()
                    .addVerdictLine('success', 'No Changes Found')
                    .addFollowupPrompt(message)
                    .build();
                stream.markdown(response);
                return {};
            }

            const finalScopeLabel =
                request.command === 'branch' ? diffResult.refName : scopeLabel;

            return this.runAnalysis(
                request,
                stream,
                token,
                diffResult,
                finalScopeLabel
            );
        } catch (error) {
            // Check error type rather than token state to avoid race conditions
            // where the error is already thrown before we can check the token
            if (isCancellationError(error)) {
                return this.handleCancellation(stream);
            }

            const errorMessage = getErrorMessage(error);
            Log.error(
                `[ChatParticipantService]: /${request.command} analysis failed`,
                error
            );

            const response = new ChatResponseBuilder()
                .addErrorSection(
                    'Analysis Error',
                    'Something went wrong during analysis. Please try again.',
                    errorMessage
                )
                .build();
            stream.markdown(response);
            return {
                errorDetails: { message: errorMessage },
                metadata: { responseIsIncomplete: true },
            };
        }
    }

    /**
     * Run analysis on diff content using AnalysisEngine.
     * Thin adapter that bridges chat UI streaming to AnalysisEngine's interface.
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

        const parsedDiff = DiffUtils.parseDiff(diffResult.diffText);
        const gitRootUri = this.deps!.gitOperations.getRepository()?.rootUri;

        // Create stream adapter for subagent tool streaming in chat UI
        const { debouncedHandler, adapter } = this.createStreamAdapter(
            stream,
            gitRootUri
        );

        // Show file tree in chat
        if (gitRootUri && parsedDiff.length > 0) {
            const fileTree = buildFileTree(parsedDiff);
            stream.filetree(fileTree, gitRootUri);
        }

        Log.info(`[ChatParticipantService]: Analyzing ${scopeLabel}`);
        stream.progress(`${ACTIVITY.analyzing} Analyzing ${scopeLabel}...`);

        const timeoutMs =
            this.deps!.workspaceSettings.getRequestTimeoutSeconds() * 1000;

        const input: AnalysisEngineInput = {
            parsedDiff,
            llmClient: new ChatLLMClient(request.model, timeoutMs),
            model: {
                family: request.model.family,
                id: request.model.id,
                name: request.model.name,
                maxInputTokens: request.model.maxInputTokens,
            },
            token,
            userPromptSuffix: request.prompt || undefined,
            chatHandler: debouncedHandler,
        };

        const output: AnalysisEngineOutput = {
            onProgress: (msg) =>
                stream.progress(`${ACTIVITY.analyzing} ${msg}`),
            onAgentProgress: () => {},
            onToolCallStart: adapter.onToolCallStart?.bind(adapter),
            onToolCallComplete: (record) => {
                adapter.onToolCallComplete?.(
                    record.id,
                    record.toolName,
                    record.arguments,
                    typeof record.result === 'string'
                        ? record.result
                        : JSON.stringify(record.result),
                    record.success,
                    record.error,
                    record.durationMs,
                    {
                        nestedToolCalls: record.nestedCalls,
                        executionTimeMs: record.executionTimeMs,
                        iterationsUsed: record.iterationsUsed,
                    }
                );
            },
            onIterationStart: adapter.onIterationStart?.bind(adapter),
        };

        const result = await this.deps!.analysisEngine.analyze(input, output);

        debouncedHandler.flush();

        if (result.wasCancelled) {
            return this.handleCancellation(stream);
        }

        if (result.error) {
            Log.error(
                '[ChatParticipantService]: Analysis failed',
                result.error
            );
            const response = new ChatResponseBuilder()
                .addErrorSection(
                    'Analysis Error',
                    'Something went wrong during analysis. Please try again.',
                    result.error
                )
                .build();
            stream.markdown(response);
            return {
                errorDetails: { message: result.error },
                metadata: { responseIsIncomplete: true },
            };
        }

        if (result.wasTruncated) {
            stream.markdown(
                `> ${SEVERITY.warning} Analysis stopped early (iteration limit or degraded state). Results are partial.\n\n`
            );
        }

        streamMarkdownWithAnchors(stream, result.analysisText, gitRootUri);

        if (result.selfReflectionScores.length > 0) {
            const scoreSummary = formatSelfReflectionScoresMarkdown(
                result.selfReflectionScores
            );
            streamMarkdownWithAnchors(stream, scoreSummary, gitRootUri);
        }

        const contentAnalysis = this.analyzeResultContent(result.analysisText);

        return {
            metadata: {
                command: request.command as 'branch' | 'changes',
                filesAnalyzed: result.filesAnalyzed,
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
                analysisResult.includes(SEVERITY.critical) ||
                analysisResult.includes(SEVERITY.high) ||
                analysisResult.includes(SEVERITY.medium),
            hasCriticalIssues: analysisResult.includes(SEVERITY.critical),
            hasSecurityIssues: analysisResult.includes('🔒'),
            hasTestingSuggestions: analysisResult.includes('🧪'),
        };
    }

    /**
     * Format a user-friendly cancellation response with correct metadata.
     */
    private handleCancellation(
        stream: vscode.ChatResponseStream
    ): vscode.ChatResult {
        Log.info('[ChatParticipantService]: Analysis cancelled by user');

        const response = new ChatResponseBuilder()
            .addVerdictLine('cancelled', 'Analysis Cancelled')
            .addFollowupPrompt(
                "Analysis was stopped before findings could be generated.\n\n*Run the command again when you're ready.*"
            )
            .build();
        stream.markdown(response);

        return {
            metadata: {
                cancelled: true,
                responseIsIncomplete: true,
            },
        };
    }

    /**
     * Create per-request subagent infrastructure.
     * Extracted to avoid duplication between exploration and analysis modes.
     *
     * Subagent tool calls are streamed to chat UI with prefixed messages
     * (e.g., "🔹 #1: Reading src/auth.ts...") for visual distinction.
     *
     * @param token Cancellation token for the request
     * @param chatHandler Optional handler for streaming subagent tool calls to chat UI
     */
    private createSubagentContext(
        token: vscode.CancellationToken,
        llmClient: ILLMClient,
        chatHandler?: ChatToolCallHandler
    ): {
        subagentSessionManager: SubagentSessionManager;
        subagentExecutor: SubagentExecutor;
    } {
        const subagentSessionManager = new SubagentSessionManager(
            this.deps!.workspaceSettings
        );
        const subagentExecutor = new SubagentExecutor(
            llmClient,
            this.deps!.toolRegistry,
            new SubagentPromptGenerator(),
            this.deps!.workspaceSettings,
            chatHandler // Pass handler for subagent tool streaming
        );
        subagentSessionManager.setParentCancellationToken(token);
        return { subagentSessionManager, subagentExecutor };
    }

    /**
     * Create stream adapter pipeline for tool-calling UI feedback.
     * Extracted to avoid duplication between exploration and analysis modes.
     *
     * @param stream The VS Code chat response stream
     * @param gitRootUri Optional Git root for resolving file paths in anchors
     */
    private createStreamAdapter(
        stream: vscode.ChatResponseStream,
        gitRootUri?: vscode.Uri
    ): {
        debouncedHandler: DebouncedStreamHandler;
        adapter: ToolCallStreamAdapter;
    } {
        const uiHandler = createChatStreamHandler(stream, gitRootUri);
        const debouncedHandler = new DebouncedStreamHandler(uiHandler);
        const adapter = new ToolCallStreamAdapter(debouncedHandler);
        return { debouncedHandler, adapter };
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
