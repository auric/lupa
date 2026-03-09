import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArray } from './schemaHelpers';

const AnalysisDimension = z.enum([
    'correctness',
    'error_handling',
    'security',
    'api_contract',
    'concurrency',
    'performance',
    'type_safety',
    'edge_cases',
]);

type AnalysisDimension = z.infer<typeof AnalysisDimension>;

const DIMENSION_QUESTIONS: Record<AnalysisDimension, string[]> = {
    correctness: [
        'Does the new code produce the same outputs for the same inputs as before?',
        'Are all code paths exercised correctly (branches, loops, early returns)?',
        'Are boundary conditions handled (empty arrays, null values, zero)?',
    ],
    error_handling: [
        'What happens when this operation fails? Is the error caught and handled?',
        'Do callers of this function handle rejection/exception properly?',
        'Are error messages informative? Are errors logged appropriately?',
    ],
    security: [
        'Is user input validated/sanitized before use?',
        'Could this change expose sensitive data (in logs, error messages, responses)?',
        'Are authentication/authorization checks in place for this path?',
    ],
    api_contract: [
        'Does this change alter a public/exported interface?',
        'Are all callers of this function updated for the new signature?',
        'Do return types match what consumers expect?',
    ],
    concurrency: [
        'Can this code be called concurrently? Is shared state protected?',
        'Are async operations properly awaited?',
        'Could this introduce race conditions or deadlocks?',
    ],
    performance: [
        'Does this change introduce O(n²) or worse complexity?',
        'Are there unnecessary allocations in hot paths?',
        'Could this block the event loop or UI thread?',
    ],
    type_safety: [
        'Are type assertions (as) used where safer alternatives exist?',
        'Could any cast hide a type error?',
        'Are generic types properly constrained?',
    ],
    edge_cases: [
        'What happens with empty input? Maximum-size input?',
        'What if the dependency (file, service, network) is unavailable?',
        'Are there off-by-one errors in ranges or loops?',
    ],
};

/**
 * Structured code reasoning tool. Forces the LLM to explicitly analyze
 * code changes through specific dimensions before concluding.
 *
 * Critical for non-reasoning models like GPT-4.1 that lack internal
 * chain-of-thought — this tool externalizes the reasoning process
 * into a structured, verifiable format.
 */
export class ReasonAboutCodeTool extends BaseTool {
    name = 'reason_about_code';
    description =
        'Analyze a specific code change through structured reasoning dimensions. ' +
        'MANDATORY before recording any MEDIUM+ finding. ' +
        'Externalizes your reasoning process — state what you observe, ' +
        'what could go wrong, and what evidence you need to verify.';

    schema = z
        .object({
            file: z
                .string()
                .describe('File path of the code change being analyzed'),
            change_summary: z
                .string()
                .describe(
                    'What specifically changed in this file (1-2 sentences)'
                ),
            dimensions: z
                .array(AnalysisDimension)
                .min(1)
                .max(4)
                .describe(
                    'Which analysis dimensions to reason through (1-4, pick the most relevant)'
                ),
            observations: z
                .array(
                    z.object({
                        dimension: AnalysisDimension,
                        observation: z
                            .string()
                            .describe('What you observe about this dimension'),
                        risk_level: z
                            .enum(['none', 'low', 'medium', 'high'])
                            .describe(
                                'Your assessment of risk in this dimension'
                            ),
                        needs_verification: z
                            .boolean()
                            .describe(
                                'Whether this observation needs tool-backed verification'
                            ),
                        verification_action: z
                            .string()
                            .optional()
                            .describe(
                                'If needs_verification, which tool call would verify this (e.g., "find_usages on functionX", "validate_claim symbol_unused")'
                            ),
                    })
                )
                .min(1)
                .describe('Your observations for each selected dimension'),
            preliminary_conclusion: z
                .enum([
                    'no_issues',
                    'potential_issues_need_verification',
                    'confirmed_issues',
                ])
                .describe(
                    'Your preliminary conclusion after reasoning through dimensions'
                ),
            next_actions: flexibleStringArray.describe(
                'Specific tool calls you plan to make next based on this reasoning'
            ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const {
            file,
            change_summary,
            dimensions,
            observations,
            preliminary_conclusion,
            next_actions,
        } = args;

        let guidance = '## Structured Code Analysis\n\n';
        guidance += `**File**: \`${file}\`\n`;
        guidance += `**Change**: ${change_summary}\n\n`;

        // Show the dimension analysis
        for (const obs of observations) {
            const riskEmoji =
                obs.risk_level === 'high'
                    ? '🔴'
                    : obs.risk_level === 'medium'
                      ? '🟡'
                      : obs.risk_level === 'low'
                        ? '🟢'
                        : '⚪';
            guidance += `### ${obs.dimension.replace(/_/g, ' ').toUpperCase()} ${riskEmoji}\n`;
            guidance += `${obs.observation}\n`;

            if (obs.needs_verification) {
                guidance += `**⚡ Needs verification**: ${obs.verification_action ?? 'unspecified'}\n`;
            }
            guidance += '\n';
        }

        // Add guiding questions for dimensions the LLM didn't address
        const analyzedDimensions = new Set(
            observations.map((o) => o.dimension)
        );
        const missingDimensions = dimensions.filter(
            (d) => !analyzedDimensions.has(d)
        );
        if (missingDimensions.length > 0) {
            guidance += '### Dimensions Not Yet Analyzed\n';
            for (const dim of missingDimensions) {
                guidance += `**${dim.replace(/_/g, ' ')}**: Consider:\n`;
                for (const q of DIMENSION_QUESTIONS[dim]) {
                    guidance += `  - ${q}\n`;
                }
            }
            guidance += '\n';
        }

        // Conclusion and next steps
        const highRiskCount = observations.filter(
            (o) => o.risk_level === 'high'
        ).length;
        const needsVerification = observations.filter(
            (o) => o.needs_verification
        ).length;

        guidance += `### Conclusion: ${preliminary_conclusion.replace(/_/g, ' ').toUpperCase()}\n`;
        guidance += `- ${highRiskCount} high-risk observation(s)\n`;
        guidance += `- ${needsVerification} observation(s) needing verification\n\n`;

        if (
            preliminary_conclusion === 'potential_issues_need_verification' &&
            needsVerification > 0
        ) {
            guidance +=
                '**Action**: Execute the verification steps above before recording any finding.\n';
            guidance +=
                'Use `find_usages`, `find_symbol`, `validate_claim`, or `read_file` to confirm.\n';
        } else if (preliminary_conclusion === 'confirmed_issues') {
            guidance +=
                '**Action**: Record confirmed findings using `record_finding`.\n';
            guidance +=
                'Include the verification evidence from this reasoning in the finding.\n';
        } else {
            guidance +=
                '**Action**: Move to the next file or area in your plan.\n';
        }

        if (next_actions.length > 0) {
            guidance += '\n### Planned Next Actions\n';
            guidance += next_actions.map((a, i) => `${i + 1}. ${a}`).join('\n');
            guidance += '\n';
        }

        return toolSuccess(guidance);
    }
}
