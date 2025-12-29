import { ITool } from '../tools/ITool';
import {
    createPRReviewPromptBuilder,
    createExplorationPromptBuilder,
} from './promptBuilder';

/**
 * Tool-aware system prompt generator for PR analysis and codebase exploration.
 *
 * Uses modular prompt blocks composed via PromptBuilder for maintainability.
 * Follows Anthropic prompt engineering best practices:
 * - Clear role definition with behavioral descriptors
 * - XML structure for prompt organization
 * - Mandatory subagent triggers for complex PRs
 * - Markdown output format for proper rendering
 */
export class ToolAwareSystemPromptGenerator {
    /**
     * Generate system prompt for PR review mode.
     * Uses modular blocks: role, tools, methodology, output format.
     */
    public generateSystemPrompt(availableTools: ITool[]): string {
        return createPRReviewPromptBuilder(availableTools).build();
    }

    /**
     * Generate exploration-focused system prompt for answering questions about the codebase.
     * Reuses tool infrastructure but removes PR/diff-specific language.
     */
    public generateExplorationPrompt(availableTools: ITool[]): string {
        return createExplorationPromptBuilder(availableTools).build();
    }
}
