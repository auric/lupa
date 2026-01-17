import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import { ConversationRunner } from '../models/conversationRunner';
import { ToolRegistry } from '../models/toolRegistry';
import { ToolExecutor } from '../models/toolExecutor';
import { CopilotModelManager } from '../models/copilotModelManager';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import { SubagentLimits } from '../models/toolConstants';
import { SubagentStreamAdapter } from '../models/subagentStreamAdapter';
import type { SubagentTask, SubagentResult } from '../types/modelTypes';
import type {
    ToolCallRecord,
    AnalysisProgressCallback,
    SubagentProgressContext,
} from '../types/toolCallTypes';
import type { ChatToolCallHandler } from '../types/chatTypes';
import type { ITool } from '../tools/ITool';
import type { ToolResultMetadata } from '@/types/toolResultTypes';
import { Log } from './loggingService';
import { isCancellationError } from '../utils/asyncUtils';
import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * Executes subagent investigations with isolated context.
 * Thin wrapper that delegates to ConversationRunner - no loop duplication.
 *
 * Created per-analysis for concurrency safety.
 *
 * Responsibilities:
 * - Create isolated conversation context per investigation
 * - Filter tools to prevent infinite recursion
 * - Stream tool calls to parent's chat UI with subagent prefix
 * - Return raw response for parent LLM to interpret
 */
export class SubagentExecutor {
    constructor(
        private readonly modelManager: CopilotModelManager,
        private readonly toolRegistry: ToolRegistry,
        private readonly promptGenerator: SubagentPromptGenerator,
        private readonly workspaceSettings: WorkspaceSettingsService,
        private readonly chatHandler?: ChatToolCallHandler,
        private readonly progressCallback?: AnalysisProgressCallback,
        private readonly progressContext?: SubagentProgressContext
    ) {}

    /**
     * Report progress with main analysis context prefix.
     */
    private reportProgress(message: string, increment?: number): void {
        if (!this.progressCallback) {
            return;
        }

        if (this.progressContext) {
            const mainIter = this.progressContext.getCurrentIteration();
            const mainMax = this.progressContext.getMaxIterations();
            this.progressCallback(
                `Turn ${mainIter}/${mainMax} → ${message}`,
                increment
            );
        } else {
            this.progressCallback(message, increment);
        }
    }

    /**
     * Execute an isolated subagent investigation.
     * @param task The investigation task
     * @param token Cancellation token
     * @param subagentId Unique ID for this subagent (for logging)
     */
    async execute(
        task: SubagentTask,
        token: vscode.CancellationToken,
        subagentId: number
    ): Promise<SubagentResult> {
        const startTime = Date.now();
        let toolCallsMade = 0;

        // Create short task label for logging and progress (first 30 chars)
        const taskLabel =
            task.task.length > 30
                ? task.task.substring(0, 30).replace(/\s+/g, ' ').trim() + '...'
                : task.task.replace(/\s+/g, ' ').trim();
        const logLabel = `Subagent #${subagentId}`;

        try {
            Log.info(`${logLabel} Starting: "${taskLabel}"`);
            this.reportProgress(`Sub-analysis: ${taskLabel}`, 0.5);

            const conversation = new ConversationManager();
            const filteredTools = this.filterTools();
            const filteredRegistry = this.createFilteredRegistry(filteredTools);

            // Pass cancellationToken so subagent tools can observe cancellation.
            // Note: planManager and subagentExecutor are NOT passed - SubagentLimits.DISALLOWED_TOOLS
            // filters out run_subagent and update_plan which require those dependencies.
            const toolExecutor = new ToolExecutor(
                filteredRegistry,
                this.workspaceSettings,
                { cancellationToken: token }
            );
            const conversationRunner = new ConversationRunner(
                this.modelManager,
                toolExecutor
            );

            const maxIterations = this.workspaceSettings.getMaxIterations();
            const systemPrompt = this.promptGenerator.generateSystemPrompt(
                task,
                filteredTools,
                maxIterations
            );

            conversation.addUserMessage(`Please investigate: ${task.task}`);

            // Track tool calls made by the subagent with full details
            const toolCalls: ToolCallRecord[] = [];

            // Create subagent stream adapter for prefixed tool progress in chat UI
            // This shows tool calls with "🔹 #N: Reading file..." format
            const subagentAdapter = this.chatHandler
                ? new SubagentStreamAdapter(this.chatHandler, subagentId)
                : undefined;

            // Run the conversation loop with labeled logging and progress reporting
            const response = await conversationRunner.run(
                {
                    systemPrompt,
                    maxIterations,
                    tools: filteredTools,
                    label: logLabel,
                },
                conversation,
                token,
                {
                    onIterationStart: (current, max) => {
                        // Report to VS Code progress bar (command palette flow).
                        // Chat UI iteration is suppressed by SubagentStreamAdapter's no-op onIterationStart.
                        this.reportProgress(
                            `Sub-analysis (${current}/${max})...`,
                            0.1
                        );
                    },
                    onToolCallStart: (
                        toolName,
                        args,
                        toolIndex,
                        totalTools
                    ) => {
                        // Forward to subagent adapter for prefixed chat UI display
                        subagentAdapter?.onToolCallStart(
                            toolName,
                            args,
                            toolIndex,
                            totalTools
                        );
                    },
                    onToolCallComplete: (
                        toolCallId: string,
                        toolName: string,
                        args: Record<string, unknown>,
                        result: string,
                        success: boolean,
                        error?: string,
                        durationMs?: number,
                        metadata?: ToolResultMetadata
                    ) => {
                        toolCallsMade++;
                        toolCalls.push({
                            id: toolCallId,
                            toolName,
                            arguments: args,
                            result,
                            success,
                            error,
                            durationMs,
                            timestamp: Date.now(),
                        });
                        // Forward to subagent adapter for chat UI completion feedback
                        subagentAdapter?.onToolCallComplete(
                            toolCallId,
                            toolName,
                            args,
                            result,
                            success,
                            error,
                            durationMs,
                            metadata
                        );
                    },
                }
            );

            const duration = Date.now() - startTime;

            // Check if cancelled (timeout or user) after run completes
            if (token.isCancellationRequested) {
                Log.warn(
                    `${logLabel} Cancelled after ${duration}ms with ${toolCallsMade} tool calls`
                );
                return {
                    success: false,
                    response: '',
                    toolCallsMade,
                    toolCalls,
                    error: 'cancelled',
                };
            }

            Log.info(
                `${logLabel} Completed in ${duration}ms with ${toolCallsMade} tool calls`
            );

            return {
                success: true,
                response,
                toolCallsMade,
                toolCalls,
            };
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }

            const errorMessage =
                error instanceof Error ? error.message : String(error);
            Log.error(`${logLabel} Failed: ${errorMessage}`);

            return {
                success: false,
                response: '',
                toolCallsMade,
                toolCalls: [],
                error: errorMessage,
            };
        }
    }

    /**
     * Filter tools to exclude run_subagent and prevent infinite recursion.
     */
    private filterTools(): ITool[] {
        return this.toolRegistry
            .getAllTools()
            .filter(
                (tool) =>
                    !SubagentLimits.DISALLOWED_TOOLS.includes(
                        tool.name as (typeof SubagentLimits.DISALLOWED_TOOLS)[number]
                    )
            );
    }

    /**
     * Create a filtered registry with only allowed tools.
     */
    private createFilteredRegistry(tools: ITool[]): ToolRegistry {
        const registry = new ToolRegistry();
        for (const tool of tools) {
            registry.registerTool(tool);
        }
        return registry;
    }
}
