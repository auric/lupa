import * as vscode from 'vscode';
import { TokenEstimator } from './contextProvider';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';

/**
 * Components of an analysis that consume tokens
 */
export interface TokenComponents {
    systemPrompt?: string;
    diffText?: string;
    context?: string;
    userMessages?: string[];
    assistantMessages?: string[];
}

/**
 * Result of token allocation calculation
 */
export interface TokenAllocation {
    totalAvailableTokens: number;
    totalRequiredTokens: number;
    systemPromptTokens: number;
    diffTextTokens: number;
    contextTokens: number;
    userMessagesTokens: number;
    assistantMessagesTokens: number;
    otherTokens: number; // Reserved for formatting, metadata, etc.
    fitsWithinLimit: boolean;
    contextAllocationTokens: number; // How many tokens can be allocated to context
}

/**
 * Service for managing token calculations and optimizations
 * Follows Single Responsibility Principle by focusing only on token management
 */
export class TokenManagerService {
    // Standard overhead for different token components
    private static readonly TOKEN_OVERHEAD_PER_MESSAGE = 5;
    private static readonly FORMATTING_OVERHEAD = 50;
    private static readonly SAFETY_MARGIN_RATIO = 0.95; // 5% safety margin

    private currentModel: vscode.LanguageModelChat | null = null;
    private modelDetails: { family: string; maxInputTokens: number } | null = null;

    constructor(private readonly modelManager: CopilotModelManager) { }

    /**
     * Calculate token allocation for all components with a specific model
     * @param components All components that will consume tokens
     * @param analysisMode Current analysis mode
     * @returns Token allocation details
     */
    public async calculateTokenAllocation(
        components: TokenComponents,
        analysisMode: AnalysisMode
    ): Promise<TokenAllocation> {
        // Get current model information
        await this.updateModelInfo();

        const modelFamily = this.modelDetails?.family || 'unknown';
        const maxInputTokens = this.modelDetails?.maxInputTokens || 8000;

        // Apply safety margin
        const safeMaxTokens = Math.floor(maxInputTokens * TokenManagerService.SAFETY_MARGIN_RATIO);

        // Calculate tokens for each component
        const systemPromptTokens = components.systemPrompt
            ? await this.currentModel!.countTokens(components.systemPrompt)
            : 0;

        const diffTextTokens = components.diffText
            ? await this.currentModel!.countTokens(components.diffText)
            : 0;

        const contextTokens = components.context
            ? await this.currentModel!.countTokens(components.context)
            : 0;

        // Calculate tokens for conversation history
        let userMessagesTokens = 0;
        if (components.userMessages) {
            for (const message of components.userMessages) {
                userMessagesTokens += await this.currentModel!.countTokens(message) || 0;
                userMessagesTokens += TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;
            }
        }

        let assistantMessagesTokens = 0;
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                assistantMessagesTokens += await this.currentModel!.countTokens(message) || 0;
                assistantMessagesTokens += TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;
            }
        }

        // Formatting overhead for markdown, etc.
        const otherTokens = TokenManagerService.FORMATTING_OVERHEAD;

        // Calculate total tokens required
        const totalRequiredTokens =
            systemPromptTokens +
            diffTextTokens +
            contextTokens +
            userMessagesTokens +
            assistantMessagesTokens +
            otherTokens;

        // Calculate how many tokens would be available for context after accounting for other components
        const nonContextTokens =
            systemPromptTokens +
            diffTextTokens +
            userMessagesTokens +
            assistantMessagesTokens +
            otherTokens;

        const contextAllocation = Math.max(0, safeMaxTokens - nonContextTokens);

        return {
            totalAvailableTokens: safeMaxTokens,
            totalRequiredTokens,
            systemPromptTokens,
            diffTextTokens,
            contextTokens,
            userMessagesTokens,
            assistantMessagesTokens,
            otherTokens,
            fitsWithinLimit: totalRequiredTokens <= safeMaxTokens,
            contextAllocationTokens: contextAllocation
        };
    }

    /**
     * Optimizes context to fit within available token allocation
     * @param context Full context content
     * @param availableTokens Maximum tokens that can be allocated to context
     * @returns Optimized context that fits within token limit
     */
    public async optimizeContext(
        context: string,
        availableTokens: number
    ): Promise<string> {
        await this.updateModelInfo();
        const modelFamily = this.modelDetails?.family || 'unknown';

        // Calculate current context tokens
        const contextTokens = await this.currentModel!.countTokens(context);

        // If context already fits, return as is
        if (contextTokens <= availableTokens) {
            return context;
        }

        console.log(`Context needs optimization: ${contextTokens} > ${availableTokens}`);

        // Simple optimization strategy: Truncate context sections
        // This is a basic approach - a more sophisticated implementation would
        // prioritize sections by relevance scores and preserve the most relevant ones

        // Split context into sections (each file is a section)
        const sections = context.split('### File:');

        if (sections.length <= 1) {
            // If can't split by sections, just truncate
            const ratio = availableTokens / contextTokens;
            const maxLength = Math.floor(context.length * ratio);
            return context.substring(0, maxLength) +
                '\n\n[Context truncated to fit token limit]';
        }

        // Keep intro text
        let optimizedContext = sections[0];
        let currentTokens = await this.currentModel!.countTokens(optimizedContext);

        // Add sections until we approach the token limit
        for (let i = 1; i < sections.length; i++) {
            const section = '### File:' + sections[i];
            const sectionTokens = await this.currentModel!.countTokens(section);

            if (currentTokens + sectionTokens <= availableTokens) {
                // This section fits, add it
                optimizedContext += section;
                currentTokens += sectionTokens;
            } else {
                // This section doesn't fit entirely
                // Calculate how much of it we can include
                const remainingTokens = availableTokens - currentTokens;
                if (remainingTokens > 100) { // Only add partial section if we have meaningful space
                    // Estimate characters per token for this model
                    let charsPerToken = 4;
                    if (modelFamily.toLowerCase().includes('claude')) {
                        charsPerToken = 5;
                    } else if (modelFamily.toLowerCase().includes('gemini')) {
                        charsPerToken = 4.5;
                    }

                    // Truncate section to fit
                    const maxChars = Math.floor(remainingTokens * charsPerToken);
                    const truncatedSection = section.substring(0, maxChars);
                    optimizedContext += truncatedSection + '\n\n[File content truncated to fit token limit]';
                }

                // Add note about omitted content
                optimizedContext += '\n\n[Additional context omitted to fit token limit]';
                break;
            }
        }

        return optimizedContext;
    }

    /**
     * Get the current model's token limit
     * @returns Maximum input tokens for current model
     */
    public async getModelTokenLimit(): Promise<number> {
        await this.updateModelInfo();
        return this.modelDetails?.maxInputTokens || 8000;
    }

    /**
     * Calculate tokens for a given text using current model
     * @param text Text to calculate tokens for
     * @returns Token count
     */
    public async calculateTokens(text: string): Promise<number> {
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
                    console.warn(`Could not find model details for ${currentModelId}, using defaults`);
                    this.modelDetails = {
                        family: 'unknown',
                        maxInputTokens: 8000
                    };
                }
            } catch (error) {
                console.error('Error getting model info:', error);
                this.modelDetails = {
                    family: 'unknown',
                    maxInputTokens: 8000
                };
            }
        }
    }

    /**
     * Get system prompt for a given analysis mode
     * @param mode Analysis mode
     * @returns System prompt text
     */
    public getSystemPromptForMode(mode: AnalysisMode): string {
        switch (mode) {
            case 'critical':
                return `You are a code review assistant focused on identifying critical issues in pull requests.
                        Analyze the code changes for bugs, errors, security vulnerabilities, and performance issues.
                        Focus only on high-impact problems that could lead to application failures, security breaches, or significant performance degradation.`;

            case 'comprehensive':
                return `You are a thorough code review assistant. Analyze the pull request for all types of issues, including:
                        - Logic errors and bugs
                        - Security vulnerabilities
                        - Performance concerns
                        - Code style and best practices
                        - Architecture and design issues
                        - Testing coverage and quality
                        Provide detailed explanations and suggestions for improvement.`;

            case 'security':
                return `You are a security-focused code review assistant. Analyze the pull request specifically for security vulnerabilities and risks, including:
                        - Injection vulnerabilities (SQL, NoSQL, command, etc.)
                        - Authentication and authorization issues
                        - Data exposure risks
                        - Insecure dependencies
                        - Cryptographic failures
                        - Security misconfiguration
                        Provide detailed explanations of each security risk and recommendations for remediation.`;

            case 'performance':
                return `You are a performance optimization specialist. Analyze the pull request for performance issues and inefficiencies, including:
                        - Algorithmic complexity problems
                        - Resource leaks
                        - Unnecessary computations
                        - I/O bottlenecks
                        - Memory usage issues
                        - Database query performance
                        Provide detailed explanations of each performance concern and suggestions for optimization.`;

            default:
                return `You are a code review assistant. Analyze the pull request changes and provide insights about potential issues, improvements, and general feedback.`;
        }
    }
}