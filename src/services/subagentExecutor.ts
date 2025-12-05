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
 * - Parse structured response format
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
     */
    async execute(
        task: SubagentTask,
        token: vscode.CancellationToken
    ): Promise<SubagentResult> {
        const startTime = Date.now();
        let toolCallsMade = 0;

        try {
            Log.info(`Subagent starting: ${task.task.substring(0, 100)}...`);

            // Create isolated conversation and tool executor for this subagent
            const conversation = new ConversationManager();
            const filteredTools = this.filterTools();
            const filteredRegistry = this.createFilteredRegistry(filteredTools);
            const toolExecutor = new ToolExecutor(filteredRegistry, this.workspaceSettings);
            const conversationRunner = new ConversationRunner(this.modelManager, toolExecutor);

            // Generate subagent-specific prompt
            const systemPrompt = this.promptGenerator.generateSystemPrompt(task, filteredTools);

            // Add initial user message with the task
            conversation.addUserMessage(`Please investigate: ${task.task}`);

            // Track tool calls made by the subagent
            const onToolCallComplete = () => {
                toolCallsMade++;
            };

            // Run the conversation loop
            const maxIterations = task.maxToolCalls ?? SubagentLimits.DEFAULT_TOOL_CALLS;
            const response = await conversationRunner.run(
                {
                    systemPrompt,
                    maxIterations,
                    tools: filteredTools
                },
                conversation,
                token,
                { onToolCallComplete }
            );

            const duration = Date.now() - startTime;
            Log.info(`Subagent completed in ${duration}ms with ${toolCallsMade} tool calls`);

            // Parse the structured response
            const parsed = this.parseResponse(response);

            return {
                success: true,
                findings: parsed.findings || response,
                summary: parsed.summary || 'Investigation completed.',
                answer: parsed.answer,
                toolCallsMade
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Log.error(`Subagent failed: ${errorMessage}`);

            return {
                success: false,
                findings: '',
                summary: '',
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

    /**
     * Parse the structured response from the subagent.
     * Extracts <findings>, <summary>, and <answer> tags.
     */
    private parseResponse(response: string): {
        findings?: string;
        summary?: string;
        answer?: string;
    } {
        const findingsMatch = response.match(/<findings>([\s\S]*?)<\/findings>/i);
        const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/i);
        const answerMatch = response.match(/<answer>([\s\S]*?)<\/answer>/i);

        return {
            findings: findingsMatch?.[1]?.trim(),
            summary: summaryMatch?.[1]?.trim(),
            answer: answerMatch?.[1]?.trim()
        };
    }
}
