import {
    generatePRReviewerRole,
    generateExplorerRole,
    generateToolSelectionGuide,
    generateExplorationToolGuide,
    generateSubagentGuidance,
    generateExplorationSubagentGuidance,
    generateAnalysisMethodology,
    generateOutputFormat,
    generateExplorationOutputFormat,
    generateSelfReflectionGuidance,
    generateRecursiveSelfReflectionGuidance,
    generateExplorationReflectionGuidance,
    generateRecursiveRootRole,
    generateRecursiveMethodology,
    generateRecursiveToolGuide,
    generateFindingQualityGuidance,
} from './blocks/promptBlocks';
import type { ModelCalibrationProfile } from '../models/modelCalibration';

/**
 * Builder for composing system prompts from modular blocks.
 *
 * Provides a fluent interface for constructing prompts with only the
 * components needed for each mode (PR review, exploration, subagent).
 */
export class PromptBuilder {
    private sections: string[] = [];
    private _calibration: ModelCalibrationProfile | undefined;

    get calibration(): ModelCalibrationProfile | undefined {
        return this._calibration;
    }

    setCalibration(profile: ModelCalibrationProfile | undefined): this {
        this._calibration = profile;
        return this;
    }

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
     * Add subagent delegation guidance for exploration mode.
     */
    addExplorationSubagentGuidance(): this {
        this.sections.push(generateExplorationSubagentGuidance());
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
     * Add self-reflection guidance for recursive root controller.
     * Reinforces delegation pattern instead of direct investigation.
     */
    addRecursiveSelfReflection(): this {
        this.sections.push(generateRecursiveSelfReflectionGuidance());
        return this;
    }

    /**
     * Add role definition for recursive root auditor.
     */
    addRecursiveRootRole(): this {
        this.sections.push(generateRecursiveRootRole());
        return this;
    }

    /**
     * Add recursive decomposition/aggregation methodology.
     */
    addRecursiveMethodology(): this {
        this.sections.push(generateRecursiveMethodology());
        return this;
    }

    /**
     * Add tool guide for recursive root controller.
     */
    addRecursiveToolGuide(): this {
        this.sections.push(generateRecursiveToolGuide());
        return this;
    }

    addFindingQualityGuidance(): this {
        this.sections.push(generateFindingQualityGuidance());
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
export function createPRReviewPromptBuilder(
    calibration?: ModelCalibrationProfile
): PromptBuilder {
    return new PromptBuilder()
        .setCalibration(calibration)
        .addPRReviewerRole()
        .addPRToolGuide()
        .addSubagentGuidance()
        .addAnalysisMethodology()
        .addFindingQualityGuidance()
        .addSelfReflection()
        .addPROutputFormat();
}

/**
 * Create a pre-configured builder for exploration prompts.
 */
export function createExplorationPromptBuilder(): PromptBuilder {
    return new PromptBuilder()
        .addExplorerRole()
        .addExplorationToolGuide()
        .addExplorationSubagentGuidance()
        .addExplorationReflection()
        .addExplorationOutputFormat();
}

/**
 * Create a pre-configured builder for recursive PR review prompts.
 * Used when maxRecursionDepth >= 1: the root agent decomposes the PR
 * into concern groups and delegates investigation to recursive sub-agents.
 */
export function createRecursiveRootPromptBuilder(
    calibration?: ModelCalibrationProfile
): PromptBuilder {
    return new PromptBuilder()
        .setCalibration(calibration)
        .addRecursiveRootRole()
        .addRecursiveToolGuide()
        .addRecursiveMethodology()
        .addFindingQualityGuidance()
        .addRecursiveSelfReflection()
        .addPROutputFormat();
}
