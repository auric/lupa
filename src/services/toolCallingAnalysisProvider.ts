import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import {
  ToolExecutor,
  type ToolExecutionRequest
} from '../models/toolExecutor';
import { CopilotModelManager } from '../models/copilotModelManager';
import { PromptGenerator } from '../models/promptGenerator';
import { TokenValidator } from '../models/tokenValidator';
import type {
  ToolCallMessage,
  ToolCall
} from '../types/modelTypes';
import type {
  ToolCallRecord,
  ToolCallsData,
  ToolCallingAnalysisResult
} from '../types/toolCallTypes';
import { TokenConstants } from '../models/tokenConstants';
import { DiffUtils } from '../utils/diffUtils';
import { Log } from './loggingService';
import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * Orchestrates the entire analysis process, including managing the conversation loop,
 * invoking tools, and interacting with the LLM.
 */
export class ToolCallingAnalysisProvider {
  private tokenValidator: TokenValidator | null = null;
  private toolCallRecords: ToolCallRecord[] = [];

  constructor(
    private conversationManager: ConversationManager,
    private toolExecutor: ToolExecutor,
    private copilotModelManager: CopilotModelManager,
    private promptGenerator: PromptGenerator,
    private workspaceSettings: WorkspaceSettingsService
  ) { }

  private get maxIterations(): number {
    return this.workspaceSettings.getMaxIterations();
  }

  /**
   * Analyze a diff using the LLM with tool-calling capabilities.
   * @param diff The diff content to analyze
   * @returns Promise resolving to the analysis result with tool call history
   */
  async analyze(diff: string, token: vscode.CancellationToken): Promise<ToolCallingAnalysisResult> {
    // Reset tool call records for new analysis
    this.toolCallRecords = [];
    let analysisCompleted = false;
    let analysisError: string | undefined;
    let analysisText = '';

    try {
      Log.info('Starting analysis with tool-calling support');

      // Clear previous conversation history for a fresh analysis
      this.conversationManager.clearHistory();

      // Check diff size and handle truncation/tool availability
      const { processedDiff, toolsAvailable, toolsDisabledMessage } = await this.processDiffSize(diff);

      // Get available tools and generate system prompt based on tool availability
      const availableTools = toolsAvailable ? this.toolExecutor.getAvailableTools() : [];
      const systemPrompt = this.promptGenerator.generateToolAwareSystemPrompt(availableTools);

      // Parse diff for structured analysis
      const parsedDiff = DiffUtils.parseDiff(processedDiff);

      // Generate user prompt with processed diff
      let userMessage = this.promptGenerator.generateToolCallingUserPrompt(processedDiff, parsedDiff);

      // Add tools disabled message if applicable
      if (toolsDisabledMessage) {
        userMessage = `${toolsDisabledMessage}\n\n${userMessage}`;
      }

      this.conversationManager.addUserMessage(userMessage);

      // Start the conversation loop with the LLM
      analysisText = await this.conversationLoop(systemPrompt, token);
      analysisCompleted = true;

      Log.info('Analysis completed successfully');

    } catch (error) {
      analysisError = error instanceof Error ? error.message : String(error);
      const errorMessage = `Error during analysis: ${analysisError}`;
      Log.error(errorMessage);
      analysisText = errorMessage;
    }

    return this.buildAnalysisResult(analysisText, analysisCompleted, analysisError);
  }

  private buildAnalysisResult(
    analysis: string,
    completed: boolean,
    error: string | undefined
  ): ToolCallingAnalysisResult {
    const successfulCalls = this.toolCallRecords.filter(r => r.success).length;
    const failedCalls = this.toolCallRecords.filter(r => !r.success).length;

    return {
      analysis,
      toolCalls: {
        calls: [...this.toolCallRecords],
        totalCalls: this.toolCallRecords.length,
        successfulCalls,
        failedCalls,
        analysisCompleted: completed,
        analysisError: error
      }
    };
  }

  /**
   * Main conversation loop that handles LLM interactions and tool calls.
   * @param systemPrompt The system prompt to use for the conversation
   * @returns Promise resolving to the final analysis result
   */
  private async conversationLoop(systemPrompt: string, token: vscode.CancellationToken): Promise<string> {
    let iteration = 0;

    while (iteration < this.maxIterations) {
      iteration++;
      Log.info(`Conversation iteration ${iteration}`);

      try {
        // Get available tools for the LLM
        const availableTools = this.toolExecutor.getAvailableTools();
        const vscodeTools = availableTools.map(tool => tool.getVSCodeTool());

        // Prepare messages for the LLM
        let messages = this.prepareMessagesForLLM(systemPrompt);

        // Initialize token validator if not already done
        if (!this.tokenValidator) {
          const currentModel = await this.copilotModelManager.getCurrentModel();
          this.tokenValidator = new TokenValidator(currentModel);
        }

        // Validate token count and clean up context if needed
        const validation = await this.tokenValidator.validateTokens(
          messages.slice(1), // Exclude system prompt from validation
          systemPrompt
        );

        if (validation.suggestedAction === 'request_final_answer') {
          // Context window is full, request final answer
          this.conversationManager.addUserMessage(
            'Context window is full. Please provide your final analysis based on the information you have gathered so far.'
          );
          messages = this.prepareMessagesForLLM(systemPrompt);
        } else if (validation.suggestedAction === 'remove_old_context') {
          // Clean up old context
          const cleanup = await this.tokenValidator.cleanupContext(
            messages.slice(1), // Exclude system prompt
            systemPrompt
          );

          // Update conversation manager with cleaned messages
          this.conversationManager.clearHistory();
          for (const message of cleanup.cleanedMessages) {
            if (message.role === 'user') {
              this.conversationManager.addUserMessage(message.content || '');
            } else if (message.role === 'assistant') {
              this.conversationManager.addAssistantMessage(message.content, message.toolCalls);
            } else if (message.role === 'tool') {
              this.conversationManager.addToolMessage(message.toolCallId || '', message.content || '');
            }
          }

          messages = this.prepareMessagesForLLM(systemPrompt);

          if (cleanup.contextFullMessageAdded) {
            Log.info(`Context cleanup: removed ${cleanup.toolResultsRemoved} tool results and ${cleanup.assistantMessagesRemoved} assistant messages`);
          }
        }

        // Send request to the LLM
        const response = await this.copilotModelManager.sendRequest({
          messages,
          tools: vscodeTools
        }, token);

        if (token.isCancellationRequested) {
          Log.info('Analysis cancelled by user');
          return 'Analysis cancelled by user';
        }

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
        if (iteration >= this.maxIterations) {
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
      let parsedArgs: Record<string, unknown> = {};

      try {
        parsedArgs = JSON.parse(call.function.arguments);
      } catch (error) {
        Log.error(`Failed to parse tool arguments for ${call.function.name}: ${call.function.arguments}`);
      }

      return {
        name: call.function.name,
        args: parsedArgs
      };
    });

    const startTime = Date.now();
    const results = await this.toolExecutor.executeTools(toolRequests);
    const endTime = Date.now();
    const avgDuration = results.length > 0 ? Math.floor((endTime - startTime) / results.length) : 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const toolCall = toolCalls[i];
      const toolCallId = toolCall.id || `tool_call_${i}`;
      const request = toolRequests[i];

      let content: string;
      let resultData: string | Record<string, unknown>;

      if (result.success) {
        if (Array.isArray(result.result)) {
          content = result.result.join('\n\n');
          resultData = content;
        } else if (typeof result.result === 'string') {
          content = result.result;
          resultData = result.result;
        } else {
          content = JSON.stringify(result.result, null, 2);
          resultData = result.result as Record<string, unknown>;
        }
      } else {
        content = `Error executing tool '${result.name}': ${result.error}`;
        resultData = content;
      }

      this.toolCallRecords.push({
        id: toolCallId,
        toolName: result.name,
        arguments: request.args as Record<string, unknown>,
        result: resultData,
        success: result.success,
        error: result.error,
        durationMs: avgDuration,
        timestamp: Date.now()
      });

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
      // Initialize token validator if not already done
      if (!this.tokenValidator) {
        const currentModel = await this.copilotModelManager.getCurrentModel();
        this.tokenValidator = new TokenValidator(currentModel);
      }

      const model = await this.copilotModelManager.getCurrentModel();
      const maxTokens = model.maxInputTokens || TokenConstants.DEFAULT_MAX_INPUT_TOKENS;

      // Parse diff for structured analysis
      const parsedDiff = DiffUtils.parseDiff(diff);

      // Generate actual system prompt and user message to get real token counts
      const availableTools = this.toolExecutor.getAvailableTools();
      const systemPrompt = this.promptGenerator.generateToolAwareSystemPrompt(availableTools);
      const userMessage = this.promptGenerator.generateToolCallingUserPrompt(diff, parsedDiff);

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
          toolsAvailable: true
        };
      }

      // If diff is too large, truncate it and disable tools
      Log.warn(`Diff uses too much context (${totalUsedTokens}/${maxTokens} tokens, only ${availableForTools} remaining). Truncating and disabling tools.`);

      // Calculate how much of the diff we can keep to leave room for basic analysis
      const targetTotalTokens = Math.floor(maxTokens * 0.8); // Use 80% for truncated content
      const targetDiffTokens = targetTotalTokens - systemPromptTokens;
      const estimatedCharsPerToken = TokenConstants.CHARS_PER_TOKEN_ESTIMATE;
      const targetChars = Math.floor(targetDiffTokens * estimatedCharsPerToken);

      // Truncate the diff
      let truncatedDiff = diff.substring(0, targetChars);

      // Try to truncate at a sensible boundary (line break)
      const lastLineBreak = truncatedDiff.lastIndexOf('\n');
      if (lastLineBreak > targetChars * 0.8) { // If line break is reasonably close to target
        truncatedDiff = truncatedDiff.substring(0, lastLineBreak);
      }

      // Add truncation indicator
      truncatedDiff += '\n\n[... diff truncated due to size ...]';

      return {
        processedDiff: truncatedDiff,
        toolsAvailable: false,
        toolsDisabledMessage: TokenConstants.TOOL_CONTEXT_MESSAGES.TOOLS_DISABLED
      };

    } catch (error) {
      Log.error('Error processing diff size:', error);
      // On error, return original diff with tools available
      return {
        processedDiff: diff,
        toolsAvailable: true
      };
    }
  }

  dispose(): void {
    // No resources to dispose of currently
  }
}