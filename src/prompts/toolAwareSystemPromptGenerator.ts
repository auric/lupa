import {
    createPRReviewPromptBuilder,
    createExplorationPromptBuilder,
    createRecursiveRootPromptBuilder,
} from './promptBuilder';
import type { ModelCalibrationProfile } from '../models/modelCalibration';

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
    public generateSystemPrompt(calibration?: ModelCalibrationProfile): string {
        return createPRReviewPromptBuilder(calibration).build();
    }

    /**
     * Generate system prompt for recursive PR review mode.
     * Root agent decomposes the PR and delegates to recursive sub-agents.
     */
    public generateRecursiveSystemPrompt(
        calibration?: ModelCalibrationProfile
    ): string {
        return createRecursiveRootPromptBuilder(calibration).build();
    }

    /**
     * Generate exploration-focused system prompt for answering questions about the codebase.
     * Reuses tool infrastructure but removes PR/diff-specific language.
     */
    public generateExplorationPrompt(): string {
        return createExplorationPromptBuilder().build();
    }
}
