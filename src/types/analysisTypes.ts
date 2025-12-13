/**
 * Target types for PR analysis that maintain consistency between
 * the diff being analyzed and the repository state accessible via tools.
 *
 * Only these two targets are valid because:
 * - Tool-calling gives LLM access to CURRENT filesystem state
 * - The diff must represent changes that match what tools can see
 *
 * Historical branches/commits would create inconsistent context:
 * the LLM would analyze old changes but reference current code.
 */
export type AnalysisTargetType =
    | 'current-branch-vs-default'
    | 'uncommitted-changes';

/**
 * UI option for analysis target selection
 */
export interface AnalysisTargetOption {
    readonly label: string;
    readonly description: string;
    readonly target: AnalysisTargetType;
}

/**
 * Predefined analysis target options for UI display
 */
export const ANALYSIS_TARGET_OPTIONS: readonly AnalysisTargetOption[] = [
    {
        label: 'Current Branch vs Default Branch',
        description: 'Compare the current branch with the default branch',
        target: 'current-branch-vs-default'
    },
    {
        label: 'Current Changes',
        description: 'Analyze uncommitted changes',
        target: 'uncommitted-changes'
    }
] as const;
