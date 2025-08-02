import { ConversationManager } from '../models/conversationManager';
import {
  ToolExecutor,
  type ToolExecutionRequest
} from '../models/toolExecutor';
import { CopilotModelManager } from '../models/copilotModelManager';
import { PromptGenerator } from '../models/promptGenerator';
import type {
  ToolCallMessage,
  ToolCall
} from '../types/modelTypes';
import type { DiffHunk, DiffHunkLine } from '../types/contextTypes';
import { DiffUtils } from '../utils/diffUtils';
import { Log } from './loggingService';

/**
 * Orchestrates the entire analysis process, including managing the conversation loop,
 * invoking tools, and interacting with the LLM.
 */
export class ToolCallingAnalysisProvider {
  constructor(
    private conversationManager: ConversationManager,
    private toolExecutor: ToolExecutor,
    private copilotModelManager: CopilotModelManager,
    private promptGenerator: PromptGenerator
  ) { }

  /**
   * Analyze a diff using the LLM with tool-calling capabilities.
   * @param diff The diff content to analyze
   * @returns Promise resolving to the analysis result
   */
  async analyze(diff: string): Promise<string> {
    try {
      Log.info('Starting analysis with tool-calling support');

      // Clear previous conversation history for a fresh analysis
      this.conversationManager.clearHistory();

      // Get available tools and generate comprehensive system prompt
      const availableTools = this.toolExecutor.getAvailableTools();
      const systemPrompt = this.promptGenerator.generateToolAwareSystemPrompt(availableTools);

      // Parse diff for structured analysis
      const parsedDiff = DiffUtils.parseDiff(diff);

      // Generate tool-calling optimized user prompt
      const userMessage = this.promptGenerator.generateToolCallingUserPrompt(diff, parsedDiff);
      this.conversationManager.addUserMessage(userMessage);

      // Start the conversation loop with the LLM
      const result = await this.conversationLoop(systemPrompt);

      Log.info('Analysis completed successfully');
      return result;

    } catch (error) {
      const errorMessage = `Error during analysis: ${error instanceof Error ? error.message : String(error)}`;
      Log.error(errorMessage);
      return errorMessage;
    }
  }

  /**
   * Main conversation loop that handles LLM interactions and tool calls.
   * @param systemPrompt The system prompt to use for the conversation
   * @returns Promise resolving to the final analysis result
   */
  private async conversationLoop(systemPrompt: string): Promise<string> {
    const maxIterations = 10; // Prevent infinite loops
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      Log.info(`Conversation iteration ${iteration}`);

      try {
        // Get available tools for the LLM
        const availableTools = this.toolExecutor.getAvailableTools();
        const vscodeTools = availableTools.map(tool => tool.getVSCodeTool());

        // Prepare messages for the LLM
        const messages = this.prepareMessagesForLLM(systemPrompt);

        // Send request to the LLM
        const response = await this.copilotModelManager.sendRequest({
          messages,
          tools: vscodeTools
        });

        // Add assistant response to conversation
        this.conversationManager.addAssistantMessage(
          response.content || null,
          response.toolCalls
        );

        // Check if the LLM wants to call tools
        if (response.toolCalls && response.toolCalls.length > 0) {
          Log.info(`Processing ${response.toolCalls.length} tool calls`);

          // Execute the requested tools
          await this.handleToolCalls(response.toolCalls);

          // Continue the conversation loop to get the LLM's response after tool execution
          continue;
        }

        // If no tool calls, we have the final response
        return response.content || 'Analysis completed but no content returned.';

      } catch (error) {
        const errorMessage = `Error in conversation iteration ${iteration}: ${error instanceof Error ? error.message : String(error)}`;
        Log.error(errorMessage);

        // For certain errors (like LLM service unavailable), re-throw to be handled by outer catch
        if (error instanceof Error && error.message.includes('service unavailable')) {
          throw error;
        }

        // Add error to conversation and try to continue
        this.conversationManager.addAssistantMessage(
          `I encountered an error: ${errorMessage}. Let me try to continue the analysis.`
        );

        // If this is the last iteration, return the error
        if (iteration >= maxIterations) {
          return errorMessage;
        }
      }
    }

    return 'Analysis reached maximum iterations. The conversation may be incomplete.';
  }

  /**
   * Handle tool calls from the LLM by executing them and adding results to the conversation.
   * @param toolCalls Array of tool calls to execute
   */
  private async handleToolCalls(toolCalls: ToolCall[]): Promise<void> {
    const toolRequests: ToolExecutionRequest[] = toolCalls.map(call => {
      let parsedArgs: any = {};

      try {
        // Parse the JSON string arguments
        parsedArgs = JSON.parse(call.function.arguments);
      } catch (error) {
        Log.error(`Failed to parse tool arguments for ${call.function.name}: ${call.function.arguments}`);
        // Leave as empty object - the tool's Zod schema will handle validation and provide proper error
      }

      return {
        name: call.function.name,
        args: parsedArgs
      };
    });

    // Execute tools in parallel
    const results = await this.toolExecutor.executeTools(toolRequests);

    // Add tool results to the conversation
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const toolCall = toolCalls[i];
      const toolCallId = toolCall.id || `tool_call_${i}`;

      let content: string;
      if (result.success) {
        // Format the tool result for the LLM
        content = Array.isArray(result.result)
          ? result.result.join('\n\n')
          : typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result, null, 2);
      } else {
        content = `Error executing tool '${result.name}': ${result.error}`;
      }

      this.conversationManager.addToolMessage(toolCallId, content);
    }
  }

  /**
   * Prepare messages for the LLM by converting conversation history to the expected format.
   * @param systemPrompt The system prompt to include
   * @returns Array of messages formatted for the LLM
   */
  private prepareMessagesForLLM(systemPrompt: string): ToolCallMessage[] {
    const messages: ToolCallMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
        toolCalls: undefined,
        toolCallId: undefined
      }
    ];

    // Add conversation history
    const history = this.conversationManager.getHistory();
    for (const message of history) {
      messages.push({
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId
      });
    }

    return messages;
  }


  dispose(): void {
    // No resources to dispose of currently
  }
}