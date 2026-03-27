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

    /**
     * Tools to disable for this model family.
     * Reduces cognitive overload for literal instruction followers (GPT-4.1).
     * Research shows fewer tools = better tool selection accuracy.
     */
    readonly disabledTools: readonly string[];

    /**
     * Maximum number of findings per review.
     * Forces prioritization: models must report only the most impactful issues.
     * GPT-4.1 benefits from tight caps (keeps focus on quality over quantity).
     */
    readonly maxFindingsPerReview: number;

    /**
     * Confidence threshold for self-reflection scoring (1-10).
     * After analysis, findings are re-scored by the model itself. Findings
     * scoring below this threshold are dropped as likely false positives.
     * Dismissive models: 5 (lower bar — they already under-report).
     * Balanced models: 7 (standard bar).
     * Aggressive models: 8 (high bar — they over-report).
     */
    readonly selfReflectionThreshold: number;
}

const GPT_41_PROFILE: ModelCalibrationProfile = {
    name: 'gpt-4.1',
    findingBias: 'dismissive',
    challengeMode: 'prosecution',
    includeFalsePositiveGuide: false,
    includeRevertTest: false,
    includeAgenticPreamble: true,
    evidenceThreshold: 'low',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 15,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 3,
        requiredToolsBeforeDone: [],
        investigationPreamble:
            'For each changed function: read the diff, then call find_usages to trace callers.\n' +
            'If a caller cannot handle the new behavior (return type, null case, error path), call record_finding immediately.\n' +
            'If find_usages returns no results for an exported/public function, try search_for_pattern as a fallback.\n' +
            'Only record findings supported by specific tool output. Do not record speculative concerns.',
    },
    disabledTools: [
        'batch_tools',
        'find_files_by_pattern',
        'get_symbols_overview',
    ],
    maxFindingsPerReview: 5,
    selfReflectionThreshold: 5,
};

const GPT_4O_PROFILE: ModelCalibrationProfile = {
    name: 'gpt-4o',
    findingBias: 'dismissive',
    challengeMode: 'prosecution',
    includeFalsePositiveGuide: false,
    includeRevertTest: false,
    includeAgenticPreamble: true,
    evidenceThreshold: 'low',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 15,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 2,
        requiredToolsBeforeDone: [],
        investigationPreamble:
            'For each changed function: read the diff, then call find_usages to trace callers.\n' +
            'If a caller cannot handle the new behavior (return type, null case, error path), call record_finding immediately.\n' +
            'If find_usages returns no results for an exported/public function, try search_for_pattern as a fallback.\n' +
            'Only record findings supported by specific tool output. Do not record speculative concerns.',
    },
    disabledTools: [
        'batch_tools',
        'find_files_by_pattern',
        'get_symbols_overview',
    ],
    maxFindingsPerReview: 5,
    selfReflectionThreshold: 5,
};

const GPT_5_MINI_PROFILE: ModelCalibrationProfile = {
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
        investigationPreamble:
            'Verify all claims with validate_claim before recording. ' +
            'Focus on precision — only record findings with concrete tool-confirmed evidence.',
    },
    disabledTools: [],
    maxFindingsPerReview: 10,
    selfReflectionThreshold: 8,
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
    includeAgenticPreamble: true,
    evidenceThreshold: 'medium',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 15,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 2,
        requiredToolsBeforeDone: [],
        investigationPreamble:
            'Verify all claims with validate_claim before recording. ' +
            'Focus on precision — only record findings with concrete tool-confirmed evidence.',
    },
    disabledTools: [],
    maxFindingsPerReview: 10,
    selfReflectionThreshold: 7,
};

const CLAUDE_PROFILE: ModelCalibrationProfile = {
    name: 'claude',
    findingBias: 'balanced',
    challengeMode: 'devils-advocate',
    includeFalsePositiveGuide: true,
    includeRevertTest: true,
    includeAgenticPreamble: false,
    evidenceThreshold: 'medium',
    adversarialVerificationThreshold: 'LOW',
    adversarialBudget: 15,
    investigationProtocol: {
        minToolCallsBeforeFirstFinding: 2,
        requiredToolsBeforeDone: [],
        investigationPreamble: '',
    },
    disabledTools: [],
    maxFindingsPerReview: 15,
    selfReflectionThreshold: 7,
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
// Order is load-bearing: more specific matchers (e.g. Raptor Mini by id) must
// precede broader family matchers (e.g. gpt-5-mini) to avoid mis-classification.
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
