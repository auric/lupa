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
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { SubagentSessionManager } from './subagentSessionManager';
import { SubagentExecutor } from './subagentExecutor';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import { PlanSessionManager } from './planSessionManager';
import { RecursiveStateManager } from '../sessions/recursiveStateManager';
import { DIFF_TOOLS } from '../models/toolConstants';
import type { ExecutionContext } from '../types/executionContext';

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
        private workspaceSettings: WorkspaceSettingsService
    ) {}

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

        // Create progress context that captures local variables
        const progressContext: SubagentProgressContext = {
            getCurrentIteration: () => currentIteration,
            getMaxIterations: () => currentMaxIterations,
        };

        // Create per-analysis instances for complete isolation
        const conversationManager = new ConversationManager();
        const planManager = new PlanSessionManager();
        const subagentSessionManager = new SubagentSessionManager(
            this.workspaceSettings
        );
        const subagentExecutor = new SubagentExecutor(
            this.copilotModelManager,
            this.toolRegistry,
            new SubagentPromptGenerator(),
            this.workspaceSettings,
            undefined, // No chat handler in command context
            progressCallback,
            progressContext
        );

        // Determine analysis approach and recursive mode.
        // Recursive mode requires BOTH: depth >= 1 AND RLM approach.
        // The RLM paper's basic pattern is depth=1 (root orchestrator + leaf workers).
        // Legacy approach is always flat — recursive prompts reference diff tools
        // that subagents don't have in legacy mode.
        const isRlmApproach =
            this.workspaceSettings.getAnalysisApproach() === 'rlm';
        const maxRecursionDepth = this.workspaceSettings.getMaxRecursionDepth();
        const isRecursiveMode = maxRecursionDepth >= 1 && isRlmApproach;

        // Create RecursiveStateManager when in recursive mode
        const recursiveState = isRecursiveMode
            ? new RecursiveStateManager(maxRecursionDepth)
            : undefined;

        // Register root agent in recursive state tree
        if (recursiveState) {
            recursiveState.registerAgent(
                undefined,
                'Root review controller',
                this.maxIterations
            );
            recursiveState.startAgent('root');
        }

        // Create execution context as a mutable reference so parsedDiff can be
        // set after diff processing (RLM approach needs it on the context for tools)
        const executionContext: ExecutionContext = {
            planManager,
            subagentSessionManager,
            subagentExecutor,
            cancellationToken: token,
            recursiveState,
            currentDepth: 0,
            currentAgentId: 'root',
        };

        const toolExecutor = new ToolExecutor(
            this.toolRegistry,
            this.workspaceSettings,
            executionContext
        );
        const conversationRunner = new ConversationRunner(
            this.copilotModelManager,
            toolExecutor
        );

        let analysisCompleted = false;
        let analysisError: string | undefined;
        let analysisText = '';
        let toolCallCount = 0;

        try {
            Log.info('Starting analysis with tool-calling support');
            progressCallback?.('Initializing analysis...', 0.5);
            subagentSessionManager.setParentCancellationToken(token);

            // Parse diff for structured analysis
            progressCallback?.('Processing diff...', 0.5);
            const parsedDiff = DiffUtils.parseDiff(diff);

            // RLM approach: tools always available — diff accessed on-demand via tools,
            // so context window size is irrelevant for tool availability.
            // Legacy approach: check if diff fits in context alongside tools.
            let toolsAvailable: boolean;
            let processedDiff: string;
            let toolsDisabledMessage: string | undefined;

            if (isRlmApproach) {
                toolsAvailable = true;
                processedDiff = diff;
                Log.info(
                    `Using RLM approach: tools always enabled, ${parsedDiff.length} files via diff tools`
                );
            } else {
                const diffResult = await this.processDiffSize(diff);
                toolsAvailable = diffResult.toolsAvailable;
                processedDiff = diffResult.processedDiff;
                toolsDisabledMessage = diffResult.toolsDisabledMessage;
            }

            // Get available tools and generate system prompt based on tool availability.
            // In legacy mode, exclude diff tools — they require parsedDiff which is only
            // set for RLM. Without filtering, the LLM could call them and get unhelpful errors.
            let availableTools = toolsAvailable
                ? toolExecutor.getAvailableTools()
                : [];
            if (!isRlmApproach) {
                availableTools = availableTools.filter(
                    (t) =>
                        !DIFF_TOOLS.includes(
                            t.name as (typeof DIFF_TOOLS)[number]
                        )
                );
            }
            const systemPrompt = isRecursiveMode
                ? this.promptGenerator.generateRecursiveSystemPrompt(
                      availableTools
                  )
                : this.promptGenerator.generateToolAwareSystemPrompt(
                      availableTools
                  );

            // Generate user prompt based on analysis approach
            let userMessage: string;
            if (isRlmApproach) {
                executionContext.parsedDiff = parsedDiff;
                userMessage = this.promptGenerator.generateRlmUserPrompt(
                    parsedDiff,
                    undefined,
                    isRecursiveMode,
                    this.workspaceSettings.getMaxSubagentsPerSession()
                );
            } else {
                // Legacy approach: full diff embedded in prompt
                const legacyParsedDiff = DiffUtils.parseDiff(processedDiff);
                userMessage =
                    this.promptGenerator.generateToolCallingUserPrompt(
                        legacyParsedDiff,
                        undefined,
                        isRecursiveMode
                    );
            }

            // Add tools disabled message if applicable (legacy only)
            if (toolsDisabledMessage) {
                userMessage = `${toolsDisabledMessage}\n\n${userMessage}`;
            }

            conversationManager.addUserMessage(userMessage);
            progressCallback?.('Starting conversation with AI model...', 0.5);

            // Create token validator for this analysis
            const model = await this.copilotModelManager.getCurrentModel();
            Log.info(
                `Using model: ${model.name} (${model.vendor}/${model.id}, ${model.maxInputTokens} tokens)`
            );
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
            analysisCompleted = !conversationRunner.wasCancelled;

            if (analysisCompleted) {
                progressCallback?.(
                    `Analysis complete (${toolCallCount} tool calls)`,
                    2
                );
                Log.info('Analysis completed successfully');
            } else {
                Log.info('Analysis was cancelled by user');
            }
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            analysisError = getErrorMessage(error);
            const errorMessage = `Error during analysis: ${analysisError}`;
            Log.error(errorMessage, error);
            analysisText = errorMessage;
        } finally {
            // Clear parent cancellation token to release references
            subagentSessionManager.setParentCancellationToken(undefined);
            // No other cleanup needed - all per-analysis instances are garbage collected
        }

        return this.buildAnalysisResult(
            toolCallRecords,
            analysisText,
            analysisCompleted,
            analysisError,
            conversationRunner.wasCancelled
        );
    }

    private buildAnalysisResult(
        toolCallRecords: ToolCallRecord[],
        analysis: string,
        completed: boolean,
        error: string | undefined,
        wasCancelled: boolean
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
            wasCancelled,
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
