import { ITool } from '../tools/ITool';
import {
    generatePRReviewerRole,
    generateExplorerRole,
    generateToolInventory,
    generateToolSelectionGuide,
    generateExplorationToolGuide,
    generateSubagentGuidance,
    generateAnalysisMethodology,
    generateOutputFormat,
    generateExplorationOutputFormat,
    generateSelfReflectionGuidance,
    generateExplorationReflectionGuidance,
} from './blocks';

/**
 * Builder for composing system prompts from modular blocks.
 *
 * Provides a fluent interface for constructing prompts with only the
 * components needed for each mode (PR review, exploration, subagent).
 */
export class PromptBuilder {
    private sections: string[] = [];

    /**
     * Add role definition for PR reviewer.
     */
    addPRReviewerRole(): this {
        this.sections.push(generatePRReviewerRole());
        return this;
    }

    /**
     * Add role definition for codebase explorer.
     */
    addExplorerRole(): this {
        this.sections.push(generateExplorerRole());
        return this;
    }

    /**
     * Add custom role definition (for subagents).
     */
    addCustomRole(role: string): this {
        this.sections.push(role);
        return this;
    }

    /**
     * Add tool inventory section with all available tools.
     */
    addToolInventory(tools: ITool[]): this {
        if (tools.length > 0) {
            this.sections.push(
                '## Available Tools\n\n' + generateToolInventory(tools)
            );
        }
        return this;
    }

    /**
     * Add tool selection guide for PR review mode.
     */
    addPRToolGuide(): this {
        this.sections.push(generateToolSelectionGuide());
        return this;
    }

    /**
     * Add tool selection guide for exploration mode.
     */
    addExplorationToolGuide(): this {
        this.sections.push(generateExplorationToolGuide());
        return this;
    }

    /**
     * Add subagent delegation guidance.
     */
    addSubagentGuidance(): this {
        this.sections.push(generateSubagentGuidance());
        return this;
    }

    /**
     * Add analysis methodology for PR review.
     */
    addAnalysisMethodology(): this {
        this.sections.push(generateAnalysisMethodology());
        return this;
    }

    /**
     * Add output format for PR review.
     */
    addPROutputFormat(): this {
        this.sections.push(generateOutputFormat());
        return this;
    }

    /**
     * Add output format for exploration.
     */
    addExplorationOutputFormat(): this {
        this.sections.push(generateExplorationOutputFormat());
        return this;
    }

    /**
     * Add self-reflection guidance for PR review.
     */
    addSelfReflection(): this {
        this.sections.push(generateSelfReflectionGuidance());
        return this;
    }

    /**
     * Add self-reflection guidance for exploration.
     */
    addExplorationReflection(): this {
        this.sections.push(generateExplorationReflectionGuidance());
        return this;
    }

    /**
     * Add a custom section.
     */
    addSection(section: string): this {
        if (section.trim()) {
            this.sections.push(section);
        }
        return this;
    }

    /**
     * Build the final prompt by joining all sections.
     */
    build(): string {
        return this.sections.join('\n\n');
    }

    /**
     * Reset the builder for reuse.
     */
    reset(): this {
        this.sections = [];
        return this;
    }
}

/**
 * Create a pre-configured builder for PR review prompts.
 */
export function createPRReviewPromptBuilder(tools: ITool[]): PromptBuilder {
    return new PromptBuilder()
        .addPRReviewerRole()
        .addToolInventory(tools)
        .addPRToolGuide()
        .addSubagentGuidance()
        .addSelfReflection()
        .addAnalysisMethodology()
        .addPROutputFormat();
}

/**
 * Create a pre-configured builder for exploration prompts.
 */
export function createExplorationPromptBuilder(tools: ITool[]): PromptBuilder {
    return new PromptBuilder()
        .addExplorerRole()
        .addToolInventory(tools)
        .addExplorationToolGuide()
        .addExplorationReflection()
        .addExplorationOutputFormat();
}
