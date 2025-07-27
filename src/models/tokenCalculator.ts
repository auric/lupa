import * as vscode from 'vscode';
import type {
    TokenComponents,
    TokenAllocation
} from '../types/contextTypes';
import type { AnalysisMode } from '../types/modelTypes';
import { CopilotModelManager } from './copilotModelManager';
import { TokenConstants } from './tokenConstants';
import { Log } from '../services/loggingService';

/**
 * Handles token allocation calculations for analysis components
 * Focuses solely on calculating token usage and allocation
 */
export class TokenCalculator {
    private currentModel: vscode.LanguageModelChat | null = null;
    private modelDetails: { family: string; maxInputTokens: number } | null = null;

    constructor(private readonly modelManager: CopilotModelManager) { }

    /**
     * Calculate token allocation for all components with a specific model
     * @param components All components that will consume tokens
     * @param analysisMode Current analysis mode
     * @returns Token allocation details
     */
    async calculateTokenAllocation(
        components: TokenComponents,
        analysisMode: AnalysisMode
    ): Promise<TokenAllocation> {
        await this.updateModelInfo();

        const maxInputTokens = this.modelDetails?.maxInputTokens || 8000;
        const safeMaxTokens = Math.floor(maxInputTokens * TokenConstants.SAFETY_MARGIN_RATIO);

        const systemPromptTokens = components.systemPrompt
            ? await this.currentModel!.countTokens(components.systemPrompt) : 0;
        const diffTokens = components.diffStructureTokens !== undefined
            ? components.diffStructureTokens
            : (components.diffText ? await this.currentModel!.countTokens(components.diffText) : 0);

        // Calculate context tokens from separated fields
        let contextTokens = 0;
        if (components.embeddingContext) {
            contextTokens += await this.currentModel!.countTokens(components.embeddingContext);
        }
        if (components.lspReferenceContext) {
            contextTokens += await this.currentModel!.countTokens(components.lspReferenceContext);
        }
        if (components.lspDefinitionContext) {
            contextTokens += await this.currentModel!.countTokens(components.lspDefinitionContext);
        }

        // Calculate content tokens only (without message overhead)
        let userMessagesTokens = 0;
        let userMessageCount = 0;
        if (components.userMessages) {
            for (const message of components.userMessages) {
                userMessagesTokens += await this.currentModel!.countTokens(message) || 0;
                userMessageCount++;
            }
        }

        let assistantMessagesTokens = 0;
        let assistantMessageCount = 0;
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                assistantMessagesTokens += await this.currentModel!.countTokens(message) || 0;
                assistantMessageCount++;
            }
        }

        // Calculate response prefill content tokens only
        const responsePrefillTokens = components.responsePrefill
            ? await this.currentModel!.countTokens(components.responsePrefill) : 0;

        // Calculate total message overhead based on actual message count
        const messageCount = (components.systemPrompt ? 1 : 0) +
            userMessageCount +
            assistantMessageCount +
            (components.responsePrefill ? 1 : 0);
        const messageOverheadTokens = messageCount * TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;

        const otherTokens = TokenConstants.FORMATTING_OVERHEAD;

        return {
            totalAvailableTokens: safeMaxTokens,
            systemPromptTokens,
            diffTextTokens: diffTokens,
            contextTokens,
            userMessagesTokens,
            assistantMessagesTokens,
            responsePrefillTokens,
            messageOverheadTokens,
            otherTokens
        };
    }

    /**
     * Calculate total tokens for given components
     * @param components Token components to calculate
     * @returns Total token count
     */
    async calculateComponentTokens(components: TokenComponents): Promise<number> {
        await this.updateModelInfo();
        if (!this.currentModel) return 0;

        let totalTokens = 0;

        if (components.systemPrompt) {
            totalTokens += await this.currentModel.countTokens(components.systemPrompt);
        }
        if (components.diffText) {
            totalTokens += await this.currentModel.countTokens(components.diffText);
        }
        // Calculate context tokens from separated fields
        if (components.embeddingContext) {
            totalTokens += await this.currentModel.countTokens(components.embeddingContext);
        }
        if (components.lspReferenceContext) {
            totalTokens += await this.currentModel.countTokens(components.lspReferenceContext);
        }
        if (components.lspDefinitionContext) {
            totalTokens += await this.currentModel.countTokens(components.lspDefinitionContext);
        }

        // Calculate message content and overhead separately
        let messageCount = 0;
        if (components.userMessages) {
            for (const message of components.userMessages) {
                totalTokens += await this.currentModel.countTokens(message);
                messageCount++;
            }
        }
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                totalTokens += await this.currentModel.countTokens(message);
                messageCount++;
            }
        }
        if (components.responsePrefill) {
            totalTokens += await this.currentModel.countTokens(components.responsePrefill);
            messageCount++;
        }

        // Add system prompt to message count if present
        if (components.systemPrompt) {
            messageCount++;
        }

        // Add message overhead
        totalTokens += messageCount * TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;
        if (components.diffStructureTokens) {
            totalTokens += components.diffStructureTokens;
        }

        return totalTokens + TokenConstants.FORMATTING_OVERHEAD;
    }

    /**
     * Calculate tokens for fixed (non-truncatable) components
     * @param components Token components to analyze
     * @returns Token count for fixed components
     */
    async calculateFixedTokens(components: TokenComponents): Promise<number> {
        await this.updateModelInfo();
        if (!this.currentModel) return 0;

        let fixedTokens = 0;

        // System prompt is fixed
        if (components.systemPrompt) {
            fixedTokens += await this.currentModel.countTokens(components.systemPrompt);
        }

        // User and assistant messages are fixed
        if (components.userMessages) {
            for (const message of components.userMessages) {
                fixedTokens += await this.currentModel.countTokens(message);
            }
        }
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                fixedTokens += await this.currentModel.countTokens(message);
            }
        }

        // Response prefill is fixed
        if (components.responsePrefill) {
            fixedTokens += await this.currentModel.countTokens(components.responsePrefill);
        }

        // Diff structure tokens (if specified instead of diffText)
        if (components.diffStructureTokens && !components.diffText) {
            fixedTokens += components.diffStructureTokens;
        }

        // Message overhead and formatting overhead are fixed
        const messageCount = (components.systemPrompt ? 1 : 0) +
            (components.userMessages?.length || 0) +
            (components.assistantMessages?.length || 0) +
            (components.responsePrefill ? 1 : 0);
        fixedTokens += messageCount * TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;
        fixedTokens += TokenConstants.FORMATTING_OVERHEAD;

        return fixedTokens;
    }

    /**
     * Calculate total tokens for complete message array that will be sent to model
     * @param systemPrompt System prompt content
     * @param userPrompt User prompt content
     * @param responsePrefill Response prefill content
     * @returns Total token count including message overhead
     */
    async calculateCompleteMessageTokens(
        systemPrompt: string,
        userPrompt: string,
        responsePrefill?: string
    ): Promise<number> {
        await this.updateModelInfo();

        let totalTokens = 0;

        // System message tokens + overhead
        totalTokens += await this.currentModel!.countTokens(systemPrompt) + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;

        // User message tokens + overhead
        totalTokens += await this.currentModel!.countTokens(userPrompt) + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;

        // Response prefill tokens + overhead (if provided)
        if (responsePrefill) {
            totalTokens += await this.currentModel!.countTokens(responsePrefill) + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;
        }

        return totalTokens;
    }

    /**
     * Get the current model's token limit
     * @returns Maximum input tokens for current model
     */
    async getModelTokenLimit(): Promise<number> {
        await this.updateModelInfo();
        return this.modelDetails?.maxInputTokens || 8000;
    }

    /**
     * Calculate tokens for a given text using current model
     * @param text Text to calculate tokens for
     * @returns Token count
     */
    async calculateTokens(text: string): Promise<number> {
        await this.updateModelInfo();
        return await this.currentModel!.countTokens(text);
    }

    /**
     * Update model information from the model manager
     */
    private async updateModelInfo(): Promise<void> {
        if (!this.currentModel) {
            try {
                // Get current model
                this.currentModel = await this.modelManager.getCurrentModel();

                // Get all models to find details for the current one
                const models = await this.modelManager.listAvailableModels();
                const currentModelId = this.currentModel.id;

                // Find the matching model details
                const modelDetail = models.find(m => m.id === currentModelId);

                if (modelDetail) {
                    this.modelDetails = {
                        family: modelDetail.family,
                        maxInputTokens: modelDetail.maxInputTokens
                    };
                } else {
                    // Fallback if we can't find details
                    Log.warn(`Could not find model details for ${currentModelId}, using defaults`);
                    this.modelDetails = {
                        family: 'unknown',
                        maxInputTokens: 8000
                    };
                }
            } catch (error) {
                Log.error('Error getting model info:', error);
                this.modelDetails = {
                    family: 'unknown',
                    maxInputTokens: 8000
                };
            }
        }
    }

    dispose(): void {
        this.currentModel = null;
        this.modelDetails = null;
    }
}