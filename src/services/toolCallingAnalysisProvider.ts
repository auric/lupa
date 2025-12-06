import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { CopilotModelManager } from '../models/copilotModelManager';
import { PromptGenerator } from '../models/promptGenerator';
import { TokenValidator } from '../models/tokenValidator';
import { ConversationRunner, type ToolCallHandler } from '../models/conversationRunner';
import type {
  ToolCallRecord,
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
  private conversationRunner: ConversationRunner;

  constructor(
    private conversationManager: ConversationManager,
    private toolExecutor: ToolExecutor,
    private copilotModelManager: CopilotModelManager,
    private promptGenerator: PromptGenerator,
    private workspaceSettings: WorkspaceSettingsService
  ) {
    this.conversationRunner = new ConversationRunner(copilotModelManager, toolExecutor);
  }

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
    this.conversationRunner.reset();
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

      // Create handler to record tool calls and provide context status
      const handler: ToolCallHandler = {
        onToolCallComplete: (toolCallId, toolName, args, result, success, error, durationMs, metadata) => {
          // nestedToolCalls is already ToolCallRecord[] - pass directly
          this.toolCallRecords.push({
            id: toolCallId,
            toolName,
            arguments: args,
            result,
            success,
            error,
            durationMs: durationMs ?? 0,
            timestamp: Date.now(),
            nestedCalls: metadata?.nestedToolCalls
          });
        },
        getContextStatusSuffix: () => this.getContextStatusSuffix()
      };

      // Run conversation loop using extracted ConversationRunner
      analysisText = await this.conversationRunner.run(
        {
          systemPrompt,
          maxIterations: this.maxIterations,
          tools: availableTools,
          label: 'Main Analysis'
        },
        this.conversationManager,
        token,
        handler
      );
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
   * Get context usage status as a suffix to append to tool responses.
   * Helps the LLM understand how much context it has remaining.
   */
  private async getContextStatusSuffix(): Promise<string> {
    if (!this.tokenValidator) {
      return '';
    }

    try {
      const systemPrompt = this.promptGenerator.generateToolAwareSystemPrompt(
        this.toolExecutor.getAvailableTools()
      );
      const messages = this.conversationManager.getHistory().map(msg => ({
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        toolCallId: msg.toolCallId
      }));

      const validation = await this.tokenValidator.validateTokens(messages, systemPrompt);
      const usagePercent = Math.round((validation.totalTokens / validation.maxTokens) * 100);
      const remainingTokens = validation.maxTokens - validation.totalTokens;

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