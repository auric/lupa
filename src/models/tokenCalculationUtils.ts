import * as vscode from 'vscode';
import { TokenComponents } from '../types/contextTypes';
import { TokenConstants } from './tokenConstants';

/**
 * Utility class for shared token calculation methods.
 * Eliminates code duplication between TokenCalculator and WaterfallTruncator.
 */
export class TokenCalculationUtils {
    /**
     * Calculates total tokens for all components including overhead.
     */
    static async calculateComponentTokens(
        components: TokenComponents,
        model: vscode.LanguageModelChat
    ): Promise<number> {
        if (!model) return 0;

        let totalTokens = 0;

        if (components.systemPrompt) {
            totalTokens += await model.countTokens(components.systemPrompt);
        }
        if (components.diffText) {
            totalTokens += await model.countTokens(components.diffText);
        }
        if (components.embeddingContext) {
            totalTokens += await model.countTokens(components.embeddingContext);
        }
        if (components.lspReferenceContext) {
            totalTokens += await model.countTokens(components.lspReferenceContext);
        }
        if (components.lspDefinitionContext) {
            totalTokens += await model.countTokens(components.lspDefinitionContext);
        }

        let messageCount = 0;
        if (components.userMessages) {
            for (const message of components.userMessages) {
                totalTokens += await model.countTokens(message);
                messageCount++;
            }
        }
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                totalTokens += await model.countTokens(message);
                messageCount++;
            }
        }
        if (components.responsePrefill) {
            totalTokens += await model.countTokens(components.responsePrefill);
            messageCount++;
        }

        if (components.systemPrompt) {
            messageCount++;
        }

        totalTokens += messageCount * TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;

        return totalTokens + TokenConstants.FORMATTING_OVERHEAD;
    }

    /**
     * Calculates tokens for fixed components (non-truncatable content).
     */
    static async calculateFixedTokens(
        components: TokenComponents,
        model: vscode.LanguageModelChat
    ): Promise<number> {
        if (!model) return 0;

        let fixedTokens = 0;

        // System prompt is fixed
        if (components.systemPrompt) {
            fixedTokens += await model.countTokens(components.systemPrompt);
        }

        // User and assistant messages are fixed
        if (components.userMessages) {
            for (const message of components.userMessages) {
                fixedTokens += await model.countTokens(message);
            }
        }
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                fixedTokens += await model.countTokens(message);
            }
        }

        // Response prefill is fixed
        if (components.responsePrefill) {
            fixedTokens += await model.countTokens(components.responsePrefill);
        }

        // No fixed diff tokens - diff is always truncatable

        // Message overhead and formatting overhead are fixed
        const messageCount = (components.systemPrompt ? 1 : 0) +
            (components.userMessages?.length || 0) +
            (components.assistantMessages?.length || 0) +
            (components.responsePrefill ? 1 : 0);
        fixedTokens += messageCount * TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;
        fixedTokens += TokenConstants.FORMATTING_OVERHEAD;

        return fixedTokens;
    }
}