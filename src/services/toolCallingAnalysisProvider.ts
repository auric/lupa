import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { CopilotModelManager } from '../models/copilotModelManager';
import { PromptGenerator } from '../models/promptGenerator';
import { TokenValidator } from '../models/tokenValidator';
import {
    ConversationRunner,
    type ToolCallHandler,
} from '../models/conversationRunner';
import type {
    ToolCallRecord,
    ToolCallingAnalysisResult,
    AnalysisProgressCallback,
    SubagentProgressContext,
} from '../types/toolCallTypes';
import { TokenConstants } from '../models/tokenConstants';
import { DiffUtils } from '../utils/diffUtils';
import { Log } from './loggingService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { SubagentSessionManager } from './subagentSessionManager';
import { SubagentExecutor } from './subagentExecutor';
import { PlanSessionManager } from './planSessionManager';

/**
 * Orchestrates the entire analysis process, including managing the conversation loop,
 * invoking tools, and interacting with the LLM.
 *
 * This class is designed to be concurrent-safe. All per-analysis state is created
 * locally within the analyze() method, allowing multiple concurrent analyses.
 */
export class ToolCallingAnalysisProvider {
    constructor(
        private toolRegistry: ToolRegistry,
        private copilotModelManager: CopilotModelManager,
        private promptGenerator: PromptGenerator,
        private workspaceSettings: WorkspaceSettingsService,
        private subagentSessionManager: SubagentSessionManager,
        private subagentExecutor: SubagentExecutor | undefined = undefined
    ) {}

    /**
     * Set the subagent executor for progress context sharing.
     * Called by ServiceManager after construction.
     */
    setSubagentExecutor(executor: SubagentExecutor): void {
        this.subagentExecutor = executor;
    }

    private get maxIterations(): number {
        return this.workspaceSettings.getMaxIterations();
    }

    /**
     * Analyze a diff using the LLM with tool-calling capabilities.
     *
     * This method is concurrent-safe: all per-analysis state is created locally,
     * allowing multiple analyses to run in parallel without interference.
     *
     * @param diff The diff content to analyze
     * @param token Cancellation token
     * @param progressCallback Optional callback for reporting progress to UI
     * @returns Promise resolving to the analysis result with tool call history
     */
    async analyze(
        diff: string,
        token: vscode.CancellationToken,
        progressCallback?: AnalysisProgressCallback
    ): Promise<ToolCallingAnalysisResult> {
        // === Per-analysis state (local for concurrent-safety) ===
        const toolCallRecords: ToolCallRecord[] = [];
        let currentIteration = 0;
        let currentMaxIterations = this.maxIterations;

        // Create per-analysis instances for complete isolation
        const conversationManager = new ConversationManager();
        const planManager = new PlanSessionManager();
        const toolExecutor = new ToolExecutor(
            this.toolRegistry,
            this.workspaceSettings,
            { planManager }
        );
        const conversationRunner = new ConversationRunner(
            this.copilotModelManager,
            toolExecutor
        );

        let analysisCompleted = false;
        let analysisError: string | undefined;
        let analysisText = '';
        let toolCallCount = 0;

        // Create progress context that captures local variables
        const progressContext: SubagentProgressContext = {
            getCurrentIteration: () => currentIteration,
            getMaxIterations: () => currentMaxIterations,
        };

        // Set up subagent progress callback with context
        if (this.subagentExecutor && progressCallback) {
            this.subagentExecutor.setProgressCallback(
                progressCallback,
                progressContext
            );
        }

        try {
            Log.info('Starting analysis with tool-calling support');
            progressCallback?.('Initializing analysis...', 0.5);
            this.subagentSessionManager.reset();
            this.subagentSessionManager.setParentCancellationToken(token);

            // Check diff size and handle truncation/tool availability
            progressCallback?.('Processing diff...', 0.5);
            const { processedDiff, toolsAvailable, toolsDisabledMessage } =
                await this.processDiffSize(diff);

            // Get available tools and generate system prompt based on tool availability
            const availableTools = toolsAvailable
                ? toolExecutor.getAvailableTools()
                : [];
            const systemPrompt =
                this.promptGenerator.generateToolAwareSystemPrompt(
                    availableTools
                );

            // Parse diff for structured analysis
            const parsedDiff = DiffUtils.parseDiff(processedDiff);

            // Generate user prompt with processed diff
            let userMessage =
                this.promptGenerator.generateToolCallingUserPrompt(parsedDiff);

            // Add tools disabled message if applicable
            if (toolsDisabledMessage) {
                userMessage = `${toolsDisabledMessage}\n\n${userMessage}`;
            }

            conversationManager.addUserMessage(userMessage);
            progressCallback?.('Starting conversation with AI model...', 0.5);

            // Create token validator for this analysis
            const model = await this.copilotModelManager.getCurrentModel();
            const tokenValidator = new TokenValidator(model);

            // Create context status function that captures local state
            const getContextStatusSuffix = async (): Promise<string> => {
                try {
                    const messages = conversationManager
                        .getHistory()
                        .map((msg) => ({
                            role: msg.role,
                            content: msg.content,
                            toolCalls: msg.toolCalls,
                            toolCallId: msg.toolCallId,
                        }));

                    const validation = await tokenValidator.validateTokens(
                        messages,
                        systemPrompt
                    );
                    const usagePercent = Math.round(
                        (validation.totalTokens / validation.maxTokens) * 100
                    );
                    const remainingTokens =
                        validation.maxTokens - validation.totalTokens;

                    if (usagePercent >= 80) {
                        return `\n\n⚠️ [Context: ${usagePercent}% used (${validation.totalTokens}/${validation.maxTokens} tokens). ${remainingTokens} remaining - consider wrapping up soon]`;
                    } else if (usagePercent >= 50) {
                        return `\n\n[Context: ${usagePercent}% used. ${remainingTokens} tokens remaining]`;
                    }
                    return '';
                } catch (error) {
                    Log.error('Error calculating context status:', error);
                    return '';
                }
            };

            // Create handler to record tool calls and track iteration for subagent context
            const handler: ToolCallHandler = {
                onIterationStart: (current, max) => {
                    currentIteration = current;
                    currentMaxIterations = max;
                    progressCallback?.(
                        `Turn ${current}/${max}: Analyzing...`,
                        0.2
                    );
                },
                onToolCallComplete: (
                    toolCallId,
                    toolName,
                    args,
                    result,
                    success,
                    error,
                    durationMs,
                    metadata
                ) => {
                    toolCallCount++;
                    toolCallRecords.push({
                        id: toolCallId,
                        toolName,
                        arguments: args,
                        result,
                        success,
                        error,
                        durationMs: durationMs ?? 0,
                        timestamp: Date.now(),
                        nestedCalls: metadata?.nestedToolCalls,
                    });
                },
                getContextStatusSuffix,
            };

            // Run conversation loop using extracted ConversationRunner
            analysisText = await conversationRunner.run(
                {
                    systemPrompt,
                    maxIterations: this.maxIterations,
                    tools: availableTools,
                    label: 'Main Analysis',
                    requiresExplicitCompletion: true,
                },
                conversationManager,
                token,
                handler
            );
            analysisCompleted = true;

            progressCallback?.(
                `Analysis complete (${toolCallCount} tool calls)`,
                2
            );
            Log.info('Analysis completed successfully');
        } catch (error) {
            analysisError =
                error instanceof Error ? error.message : String(error);
            const errorMessage = `Error during analysis: ${analysisError}`;
            Log.error(errorMessage);
            analysisText = errorMessage;
        } finally {
            // Clear subagent progress callback
            this.subagentExecutor?.setProgressCallback(undefined, undefined);
            this.subagentSessionManager.setParentCancellationToken(undefined);
            // No cleanup needed - all per-analysis instances are garbage collected
        }

        return this.buildAnalysisResult(
            toolCallRecords,
            analysisText,
            analysisCompleted,
            analysisError
        );
    }

    private buildAnalysisResult(
        toolCallRecords: ToolCallRecord[],
        analysis: string,
        completed: boolean,
        error: string | undefined
    ): ToolCallingAnalysisResult {
        const successfulCalls = toolCallRecords.filter((r) => r.success).length;
        const failedCalls = toolCallRecords.filter((r) => !r.success).length;

        return {
            analysis,
            toolCalls: {
                calls: [...toolCallRecords],
                totalCalls: toolCallRecords.length,
                successfulCalls,
                failedCalls,
                analysisCompleted: completed,
                analysisError: error,
            },
        };
    }

    /**
     * Process diff size and determine if tools should be available
     * @param diff Original diff content
     * @returns Object with processed diff, tool availability, and disabled message
     */
    private async processDiffSize(diff: string): Promise<{
        processedDiff: string;
        toolsAvailable: boolean;
        toolsDisabledMessage?: string;
    }> {
        try {
            const model = await this.copilotModelManager.getCurrentModel();
            const maxTokens =
                model.maxInputTokens || TokenConstants.DEFAULT_MAX_INPUT_TOKENS;

            // Parse diff for structured analysis
            const parsedDiff = DiffUtils.parseDiff(diff);

            // Generate actual system prompt and user message to get real token counts
            const availableTools = this.toolRegistry.getAllTools();
            const systemPrompt =
                this.promptGenerator.generateToolAwareSystemPrompt(
                    availableTools
                );
            const userMessage =
                this.promptGenerator.generateToolCallingUserPrompt(parsedDiff);

            // Count real tokens for actual content that will be sent
            const systemPromptTokens = await model.countTokens(systemPrompt);
            const userMessageTokens = await model.countTokens(userMessage);
            const totalUsedTokens = systemPromptTokens + userMessageTokens;

            // Leave significant room for tool conversations (30% of total context)
            const minSpaceForTools = Math.floor(maxTokens * 0.3);
            const availableForTools = maxTokens - totalUsedTokens;

            // If there's enough space for meaningful tool interactions, enable tools
            if (availableForTools >= minSpaceForTools) {
                return {
                    processedDiff: diff,
                    toolsAvailable: true,
                };
            }

            // If diff is too large, truncate it and disable tools
            Log.warn(
                `Diff uses too much context (${totalUsedTokens}/${maxTokens} tokens, only ${availableForTools} remaining). Truncating and disabling tools.`
            );

            // Calculate how much of the diff we can keep to leave room for basic analysis
            const targetTotalTokens = Math.floor(maxTokens * 0.8); // Use 80% for truncated content
            const targetDiffTokens = targetTotalTokens - systemPromptTokens;
            const estimatedCharsPerToken =
                TokenConstants.CHARS_PER_TOKEN_ESTIMATE;
            const targetChars = Math.floor(
                targetDiffTokens * estimatedCharsPerToken
            );

            // Truncate the diff
            let truncatedDiff = diff.substring(0, targetChars);

            // Try to truncate at a sensible boundary (line break)
            const lastLineBreak = truncatedDiff.lastIndexOf('\n');
            if (lastLineBreak > targetChars * 0.8) {
                // If line break is reasonably close to target
                truncatedDiff = truncatedDiff.substring(0, lastLineBreak);
            }

            // Add truncation indicator
            truncatedDiff += '\n\n[... diff truncated due to size ...]';

            return {
                processedDiff: truncatedDiff,
                toolsAvailable: false,
                toolsDisabledMessage:
                    TokenConstants.TOOL_CONTEXT_MESSAGES.TOOLS_DISABLED,
            };
        } catch (error) {
            Log.error('Error processing diff size:', error);
            // On error, return original diff with tools available
            return {
                processedDiff: diff,
                toolsAvailable: true,
            };
        }
    }

    dispose(): void {
        // No resources to dispose of currently
    }
}
