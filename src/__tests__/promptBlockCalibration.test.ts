import { describe, it, expect } from 'vitest';
import { generatePRReviewerRole } from '../prompts/blocks/roleDefinitions';
import { generateAnalysisMethodology } from '../prompts/blocks/analysisMethodology';
import { generateSelfReflectionGuidance } from '../prompts/blocks/selfReflection';
import { generateFindingQualityGuidance } from '../prompts/blocks/findingQualityGuidance';
import type { ModelCalibrationProfile } from '../models/modelCalibration';

const DISMISSIVE_PROFILE: ModelCalibrationProfile = {
    name: 'gpt-4.1',
    findingBias: 'dismissive',
    challengeMode: 'prosecution',
    includeFalsePositiveGuide: false,
    includeRevertTest: false,
    includeAgenticPreamble: true,
    evidenceThreshold: 'low',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 20,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 3,
        requiredToolsBeforeDone: [],
        investigationPreamble: '',
    },
};

const AGGRESSIVE_PROFILE: ModelCalibrationProfile = {
    name: 'gpt-5-mini',
    findingBias: 'aggressive',
    challengeMode: 'devils-advocate',
    includeFalsePositiveGuide: true,
    includeRevertTest: true,
    includeAgenticPreamble: true,
    evidenceThreshold: 'high',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 15,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 2,
        requiredToolsBeforeDone: [],
        investigationPreamble: '',
    },
};

const BALANCED_PROFILE: ModelCalibrationProfile = {
    name: 'claude',
    findingBias: 'balanced',
    challengeMode: 'devils-advocate',
    includeFalsePositiveGuide: true,
    includeRevertTest: true,
    includeAgenticPreamble: false,
    evidenceThreshold: 'medium',
    adversarialVerificationThreshold: 'CRITICAL',
    adversarialBudget: 20,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 2,
        requiredToolsBeforeDone: [],
        investigationPreamble: '',
    },
};

describe('Calibration-aware prompt blocks', () => {
    describe('generatePRReviewerRole', () => {
        it('should include agentic preamble for dismissive models', () => {
            const role = generatePRReviewerRole(DISMISSIVE_PROFILE);
            expect(role).toContain('autonomous agent');
            expect(role).toContain('PERSISTENCE');
        });

        it('should not include agentic preamble for balanced models', () => {
            const role = generatePRReviewerRole(BALANCED_PROFILE);
            expect(role).not.toContain('autonomous agent');
        });

        it('should emphasize persistence for dismissive models', () => {
            const role = generatePRReviewerRole(DISMISSIVE_PROFILE);
            expect(role).toContain('Persistence');
            expect(role).toContain('disciplined investigator');
        });

        it('should not mention "zero findings" for dismissive models', () => {
            const role = generatePRReviewerRole(DISMISSIVE_PROFILE);
            expect(role).not.toContain('zero actionable findings');
        });

        it('should mention "zero findings" for aggressive models', () => {
            const role = generatePRReviewerRole(AGGRESSIVE_PROFILE);
            expect(role).toContain('zero actionable findings');
        });

        it('should emphasize precision for aggressive models', () => {
            const role = generatePRReviewerRole(AGGRESSIVE_PROFILE);
            expect(role).toContain('precision over volume');
            expect(role).toContain('False positives erode');
        });

        it('should produce balanced output with balanced profile', () => {
            const role = generatePRReviewerRole(BALANCED_PROFILE);
            expect(role).toContain('Staff Engineer');
            expect(role).toContain('update_plan');
        });
    });

    describe('generateAnalysisMethodology', () => {
        it('should remove kill ratio for dismissive models', () => {
            const methodology = generateAnalysisMethodology(DISMISSIVE_PROFILE);
            expect(methodology).not.toContain('Target kill ratio');
            expect(methodology).toContain('Evidence ambiguity');
        });

        it('should include stricter kill ratio for aggressive models', () => {
            const methodology = generateAnalysisMethodology(AGGRESSIVE_PROFILE);
            expect(methodology).toContain('Target kill ratio');
            expect(methodology).toContain('50-70%');
        });

        it('should include standard kill ratio for balanced models', () => {
            const methodology = generateAnalysisMethodology(BALANCED_PROFILE);
            expect(methodology).toContain('Target kill ratio');
            expect(methodology).toContain('40-60%');
        });

        it('should strengthen skepticism for dismissive models', () => {
            const methodology = generateAnalysisMethodology(DISMISSIVE_PROFILE);
            expect(methodology).toContain('submit_review will reject');
            expect(methodology).toContain('quality means accuracy, not volume');
        });

        it('should produce balanced output with balanced profile', () => {
            const methodology = generateAnalysisMethodology(BALANCED_PROFILE);
            expect(methodology).toContain('Analysis Process');
            expect(methodology).toContain('update_plan');
        });
    });

    describe('generateSelfReflectionGuidance', () => {
        it('should use prosecution mode for dismissive models', () => {
            const reflection =
                generateSelfReflectionGuidance(DISMISSIVE_PROFILE);
            expect(reflection).toContain('evidence review');
            expect(reflection).toContain(
                'What did the tool output actually show'
            );
        });

        it("should use devil's advocate for balanced models", () => {
            const reflection = generateSelfReflectionGuidance(BALANCED_PROFILE);
            expect(reflection).toContain('task alignment');
            expect(reflection).toContain('disproof you attempted');
        });

        it("should use devil's advocate for aggressive models", () => {
            const reflection =
                generateSelfReflectionGuidance(AGGRESSIVE_PROFILE);
            expect(reflection).toContain('task alignment');
            expect(reflection).toContain('disproof you attempted');
        });

        it('should produce balanced output with balanced profile', () => {
            const reflection = generateSelfReflectionGuidance(BALANCED_PROFILE);
            expect(reflection).toContain('Self-Reflection');
            expect(reflection).toContain('submit_review');
        });
    });

    describe('generateFindingQualityGuidance', () => {
        it('should omit revert test for dismissive models', () => {
            const guidance = generateFindingQualityGuidance(DISMISSIVE_PROFILE);
            expect(guidance).not.toContain('Revert Test');
            expect(guidance).toContain('Scope: Changed Code Only');
        });

        it('should include revert test for balanced models', () => {
            const guidance = generateFindingQualityGuidance(BALANCED_PROFILE);
            expect(guidance).toContain('Revert Test');
        });

        it('should omit FP anti-patterns for dismissive models', () => {
            const guidance = generateFindingQualityGuidance(DISMISSIVE_PROFILE);
            expect(guidance).not.toContain('Top False Positive Patterns');
            expect(guidance).not.toContain('Design Intent Blindness');
        });

        it('should include FP anti-patterns for aggressive models', () => {
            const guidance = generateFindingQualityGuidance(AGGRESSIVE_PROFILE);
            expect(guidance).toContain(
                'Top False Positive Patterns — Avoid These'
            );
            expect(guidance).toContain('Design Intent Blindness');
        });

        it('should include investigation thoroughness for dismissive models', () => {
            const guidance = generateFindingQualityGuidance(DISMISSIVE_PROFILE);
            expect(guidance).toContain('Investigation Thoroughness');
            expect(guidance).toContain('Missing a real bug is costlier');
        });

        it('should include precision statement for balanced models', () => {
            const guidance = generateFindingQualityGuidance(BALANCED_PROFILE);
            expect(guidance).toContain('Precision > Recall');
            expect(guidance).toContain('zero reportable findings');
        });

        it('should use low evidence bar for dismissive models', () => {
            const guidance = generateFindingQualityGuidance(DISMISSIVE_PROFILE);
            expect(guidance).toContain('suggests a potential issue');
        });

        it('should use high evidence bar for aggressive models', () => {
            const guidance = generateFindingQualityGuidance(AGGRESSIVE_PROFILE);
            expect(guidance).toContain(
                'specific tool output reveals a concrete problem'
            );
        });

        it('should produce balanced output with balanced profile', () => {
            const guidance = generateFindingQualityGuidance(BALANCED_PROFILE);
            expect(guidance).toContain('Finding Quality Standards');
            expect(guidance).toContain('Verification Gates');
            // Balanced profile includes revert test and FP patterns
            expect(guidance).toContain('Revert Test');
            expect(guidance).toContain('Top False Positive Patterns');
        });
    });
});
