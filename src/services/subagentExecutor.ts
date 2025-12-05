import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import { ConversationRunner } from '../models/conversationRunner';
import { ToolRegistry } from '../models/toolRegistry';
import { ToolExecutor } from '../models/toolExecutor';
import { CopilotModelManager } from '../models/copilotModelManager';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import { SubagentLimits } from '../models/toolConstants';
import type { SubagentTask, SubagentResult } from '../types/modelTypes';
import type { ITool } from '../tools/ITool';
import { Log } from './loggingService';
import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * Executes subagent investigations with isolated context.
 * Thin wrapper that delegates to ConversationRunner - no loop duplication.
 *
 * Responsibilities:
 * - Create isolated conversation context per investigation
 * - Filter tools to prevent infinite recursion
 * - Return raw response for parent LLM to interpret
 */
export class SubagentExecutor {
    constructor(
        private readonly modelManager: CopilotModelManager,
        private readonly toolRegistry: ToolRegistry,
        private readonly promptGenerator: SubagentPromptGenerator,
        private readonly workspaceSettings: WorkspaceSettingsService
    ) { }

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

        // Create short task label for logging (first 50 chars of task)
        const taskLabel = task.task.length > 50
            ? task.task.substring(0, 50).replace(/\s+/g, ' ').trim() + '...'
            : task.task.replace(/\s+/g, ' ').trim();
        const logLabel = `Subagent #${subagentId}`;

        try {
            Log.info(`${logLabel} Starting: "${taskLabel}"`);

            // Create isolated conversation and tool executor for this subagent
            const conversation = new ConversationManager();
            const filteredTools = this.filterTools();
            const filteredRegistry = this.createFilteredRegistry(filteredTools);
            const toolExecutor = new ToolExecutor(filteredRegistry, this.workspaceSettings);
            const conversationRunner = new ConversationRunner(this.modelManager, toolExecutor);

            // Generate subagent-specific prompt using workspace settings for limits
            const maxIterations = task.maxToolCalls ?? this.workspaceSettings.getMaxIterations();
            const systemPrompt = this.promptGenerator.generateSystemPrompt(task, filteredTools, maxIterations);

            // Add initial user message with the task
            conversation.addUserMessage(`Please investigate: ${task.task}`);

            // Track tool calls made by the subagent
            const onToolCallComplete = () => {
                toolCallsMade++;
            };

            // Run the conversation loop with labeled logging
            const response = await conversationRunner.run(
                {
                    systemPrompt,
                    maxIterations,
                    tools: filteredTools,
                    label: logLabel
                },
                conversation,
                token,
                { onToolCallComplete }
            );

            const duration = Date.now() - startTime;
            Log.info(`${logLabel} Completed in ${duration}ms with ${toolCallsMade} tool calls`);

            // Return raw response - parent LLM can interpret it naturally
            return {
                success: true,
                response,
                toolCallsMade
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Log.error(`${logLabel} Failed: ${errorMessage}`);

            return {
                success: false,
                response: '',
                toolCallsMade,
                error: errorMessage
            };
        }
    }

    /**
     * Filter tools to exclude run_subagent and prevent infinite recursion.
     */
    private filterTools(): ITool[] {
        return this.toolRegistry.getAllTools().filter(
            tool => !SubagentLimits.DISALLOWED_TOOLS.includes(tool.name as typeof SubagentLimits.DISALLOWED_TOOLS[number])
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
