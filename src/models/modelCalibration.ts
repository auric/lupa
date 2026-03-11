import type { FindingSeverity } from '../types/findingTypes';

/**
 * Model-specific calibration profiles for PR review.
 *
 * Different LLMs sit at different points on the false-negative / false-positive spectrum.
 * These profiles push each model toward balanced review quality by adjusting:
 * - Prompt content (what guidance the model receives)
 * - Challenge mode (prosecution vs devil's advocate)
 * - Evidence thresholds (how much proof is needed before recording)
 * - Tool enforcement (hard gates on submit_review)
 */

export type FindingBias = 'dismissive' | 'balanced' | 'aggressive';
export type ChallengeMode = 'prosecution' | 'devils-advocate';
export type EvidenceThreshold = 'low' | 'medium' | 'high';

export interface InvestigationProtocol {
    /** Minimum tool calls before the first record_finding is accepted */
    readonly minToolCallsBeforeFirstFinding: number;
    /** Tool names that MUST appear in toolNamesCalled before accepting response */
    readonly requiredToolsBeforeDone: readonly string[];
    /** Step-by-step investigation instructions injected into prompt for this model */
    readonly investigationPreamble: string;
}

export interface ModelCalibrationProfile {
    /** Human-readable profile name for logging */
    readonly name: string;

    /** Where this model sits on the FN/FP spectrum */
    readonly findingBias: FindingBias;

    /**
     * Prosecution: forces model to argue FOR findings (counters dismissive bias).
     * Devil's advocate: forces model to argue AGAINST findings (counters aggressive bias).
     */
    readonly challengeMode: ChallengeMode;

    /**
     * Include the false-positive anti-pattern list in prompts.
     * For dismissive models: false (it teaches dismissal patterns).
     * For aggressive models: true (helps filter noise).
     */
    readonly includeFalsePositiveGuide: boolean;

    /**
     * Include the "revert test" in finding quality guidance.
     * For dismissive models: false (provides a framework for rubber-stamping).
     * For balanced/aggressive: true (helps evaluate PR relevance).
     */
    readonly includeRevertTest: boolean;

    /**
     * Minimum validate_claim calls required before submit_review is accepted.
     * For dismissive models: >= 1 to force tool-based verification.
     * For balanced/aggressive models: 0 (no gate needed).
     */
    readonly minValidateClaimBeforeSubmit: number;

    /**
     * OpenAI-style agentic preamble prepended to the role definition.
     * GPT models benefit from explicit "be an agent, use tools, don't guess" instructions.
     * Claude models don't need this — it can actually reduce quality.
     */
    readonly includeAgenticPreamble: boolean;

    /**
     * Evidence threshold wording that calibrates how much proof is needed.
     * Low: "Record when evidence suggests a potential issue" (for dismissive models).
     * Medium: "Record when evidence confirms an issue" (balanced).
     * High: "Record ONLY with strong, concrete evidence" (for aggressive models).
     */
    readonly evidenceThreshold: EvidenceThreshold;

    /**
     * Minimum severity for adversarial verification subagents.
     * Findings at or above this severity get a dedicated adversarial agent that tries to disprove them.
     * For high-FP models: 'MEDIUM' to verify all meaningful findings.
     * For balanced models: 'CRITICAL' (current default behavior).
     */
    readonly adversarialVerificationThreshold: FindingSeverity;

    /** Iteration budget for adversarial verification subagents. Higher = more thorough but slower. */
    readonly adversarialBudget: number;

    /**
     * Model-specific investigation protocol.
     * Defines minimum investigation depth, required tools, and structured instructions.
     * Critical for GPT-4.1 which tends to stop early without explicit guidance.
     */
    readonly investigationProtocol: InvestigationProtocol;
}

const GPT_41_PROFILE: ModelCalibrationProfile = {
    name: 'gpt-4.1',
    findingBias: 'dismissive',
    challengeMode: 'prosecution',
    includeFalsePositiveGuide: false,
    includeRevertTest: false,
    minValidateClaimBeforeSubmit: 1,
    includeAgenticPreamble: true,
    evidenceThreshold: 'low',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 10,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 5,
        requiredToolsBeforeDone: [
            'get_file_diff',
            'find_symbol',
            'validate_claim',
        ],
        investigationPreamble:
            'You MUST keep investigating until you have thoroughly examined every assigned file. ' +
            'Do NOT stop early or yield control prematurely. ' +
            'For EACH changed function: (1) read the diff, (2) read the full implementation with find_symbol, ' +
            '(3) trace callers with find_usages, (4) verify claims with validate_claim. ' +
            'You MUST plan extensively before each tool call and reflect on results after.',
    },
};

const GPT_4O_PROFILE: ModelCalibrationProfile = {
    name: 'gpt-4o',
    findingBias: 'dismissive',
    challengeMode: 'prosecution',
    includeFalsePositiveGuide: true,
    includeRevertTest: false,
    minValidateClaimBeforeSubmit: 1,
    includeAgenticPreamble: true,
    evidenceThreshold: 'low',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 10,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 3,
        requiredToolsBeforeDone: ['validate_claim'],
        investigationPreamble:
            'Investigate thoroughly before recording findings. ' +
            'Use validate_claim to verify factual claims before recording. ' +
            'Do not stop at diff reading — trace dependencies and verify assumptions with tools.',
    },
};

const GPT_5_MINI_PROFILE: ModelCalibrationProfile = {
    name: 'gpt-5-mini',
    findingBias: 'aggressive',
    challengeMode: 'devils-advocate',
    includeFalsePositiveGuide: true,
    includeRevertTest: true,
    minValidateClaimBeforeSubmit: 0,
    includeAgenticPreamble: true,
    evidenceThreshold: 'high',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 8,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 2,
        requiredToolsBeforeDone: ['validate_claim'],
        investigationPreamble:
            'Verify all claims with validate_claim before recording. ' +
            'Focus on precision — only record findings with concrete tool-confirmed evidence.',
    },
};

/**
 * Raptor mini: Microsoft fine-tune of GPT-5 mini for coding.
 * Reports as family "gpt-5-mini" but id "oswe-vscode-prime" or "oswe-vscode".
 * Lower FP ratio than raw GPT-5 mini, balanced finding behavior.
 */
const RAPTOR_MINI_PROFILE: ModelCalibrationProfile = {
    name: 'raptor-mini',
    findingBias: 'balanced',
    challengeMode: 'devils-advocate',
    includeFalsePositiveGuide: true,
    includeRevertTest: true,
    minValidateClaimBeforeSubmit: 0,
    includeAgenticPreamble: true,
    evidenceThreshold: 'medium',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 8,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 2,
        requiredToolsBeforeDone: ['validate_claim'],
        investigationPreamble:
            'Verify all claims with validate_claim before recording. ' +
            'Focus on precision — only record findings with concrete tool-confirmed evidence.',
    },
};

const CLAUDE_PROFILE: ModelCalibrationProfile = {
    name: 'claude',
    findingBias: 'balanced',
    challengeMode: 'devils-advocate',
    includeFalsePositiveGuide: true,
    includeRevertTest: true,
    minValidateClaimBeforeSubmit: 0,
    includeAgenticPreamble: false,
    evidenceThreshold: 'medium',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 8,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 2,
        requiredToolsBeforeDone: [],
        investigationPreamble: '',
    },
};

export const DEFAULT_PROFILE: ModelCalibrationProfile = {
    ...CLAUDE_PROFILE,
    name: 'default',
};

/**
 * Match model family/id strings to calibration profiles.
 * Uses startsWith/includes matching to handle version suffixes
 * (e.g., "gpt-4.1-2025-04-14" matches "gpt-4.1").
 */
const MODEL_MATCHERS: Array<{
    test: (family: string, id: string) => boolean;
    profile: ModelCalibrationProfile;
}> = [
    {
        test: (family, id) => family === 'gpt-4.1' || id.startsWith('gpt-4.1'),
        profile: GPT_41_PROFILE,
    },
    {
        test: (family, id) => family === 'gpt-4o' || id.startsWith('gpt-4o'),
        profile: GPT_4O_PROFILE,
    },
    {
        test: (_family, id) => id.startsWith('oswe-vscode'),
        profile: RAPTOR_MINI_PROFILE,
    },
    {
        test: (family, id) =>
            family === 'gpt-5-mini' ||
            id.startsWith('gpt-5-mini') ||
            id.startsWith('gpt-5mini'),
        profile: GPT_5_MINI_PROFILE,
    },
    {
        test: (family, _id) =>
            family.startsWith('claude') || family.includes('sonnet'),
        profile: CLAUDE_PROFILE,
    },
];

export function getCalibrationProfile(
    family: string,
    id: string
): ModelCalibrationProfile {
    const familyLower = (family ?? '').toLowerCase();
    const idLower = (id ?? '').toLowerCase();

    for (const matcher of MODEL_MATCHERS) {
        if (matcher.test(familyLower, idLower)) {
            return matcher.profile;
        }
    }

    return DEFAULT_PROFILE;
}

export function isDismissiveModel(profile: ModelCalibrationProfile): boolean {
    return profile.findingBias === 'dismissive';
}

export function isAggressiveModel(profile: ModelCalibrationProfile): boolean {
    return profile.findingBias === 'aggressive';
}
