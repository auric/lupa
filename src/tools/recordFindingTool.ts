import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import type { FindingBias } from '../models/modelCalibration';

export class RecordFindingTool extends BaseTool {
    name = 'record_finding';
    description =
        'MANDATORY: Record each confirmed finding IMMEDIATELY after verification. ' +
        'Findings recorded here survive timeout — unrecorded findings are LOST. ' +
        "PREREQUISITE: You must call validate_claim AND a devil's advocate think checkpoint before this tool. " +
        'Only record findings that survived both LSP verification and your counter-argument.';

    schema = z.object({
        severity: z
            .string()
            .transform((s) => s.toUpperCase())
            .pipe(z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']))
            .describe('Finding severity: CRITICAL, HIGH, MEDIUM, or LOW'),
        title: z.string().describe('Brief finding title'),
        file: z.string().describe('Primary file path affected'),
        line: z.coerce.number().describe('Primary line number (1-indexed)'),
        description: z
            .string()
            .describe(
                'Detailed description: what is wrong, what tool calls confirmed it, and what could go wrong'
            ),
        disproof_note: z
            .string()
            .describe(
                'How you tried to disprove this finding and why it survived (e.g., "Checked callers with find_usages — all 3 callers pass unvalidated input")'
            )
            .optional()
            .default(''),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        const store = context.findingStore;
        if (!store) {
            return toolError('Finding store not available in this context');
        }

        const finding = store.record({
            agentId: context.currentAgentId ?? 'unknown',
            severity: args.severity,
            category: 'general',
            title: args.title,
            file: args.file,
            lineRange: [args.line, args.line],
            description: args.description,
            supportingToolCalls: [],
            disproof: {
                attempted: args.disproof_note.length > 0,
                method: args.disproof_note,
                result: args.disproof_note,
            },
            verifiableClaims: [],
        });

        const base = `Finding recorded: [${finding.id}] ${finding.severity} — ${finding.title}`;
        const fpChallenge = this.buildFPChallenge(
            args,
            context.calibrationProfile.findingBias
        );
        return toolSuccess(fpChallenge ? `${base}\n\n${fpChallenge}` : base);
    }

    /**
     * Generate pattern-specific FP challenge questions injected into the tool
     * response. For dismissive models (prosecution mode) this is the ONLY FP
     * awareness they receive — the system prompt omits the FP guide to avoid
     * enabling dismissal.
     */
    private buildFPChallenge(
        args: z.infer<typeof this.schema>,
        findingBias: FindingBias
    ): string | null {
        const text = `${args.title} ${args.description}`.toLowerCase();
        const challenges: string[] = [];

        // Pattern-specific checks based on the 6 most common FP categories
        if (/race\s*condition|concurren|thread.?safe|atomicity/.test(text)) {
            challenges.push(
                'Did you verify the runtime concurrency model? In single-threaded runtimes (Node.js), synchronous operations CANNOT race.'
            );
        }

        if (
            /type\s*(mismatch|error|wrong|safety)|union\s*type|cast/.test(text)
        ) {
            challenges.push(
                'Did you call validate_claim to verify the type claim? The type system may already guarantee correctness at compile time.'
            );
        }

        if (
            /missing\s*(validation|check|guard|sanitiz)|no\s*(validation|check)/.test(
                text
            )
        ) {
            challenges.push(
                'Did you trace ALL callers to confirm invalid input can actually reach this code? A caller or middleware may already validate.'
            );
        }

        if (/missing\s*test|no\s*test|untested|test\s*coverage/.test(text)) {
            challenges.push(
                'Did you search __tests__/ for the function name and synonyms? The test may exist under a different name.'
            );
        }

        if (
            /unused|dead\s*code|no\s*callers|unreachable|never\s*(called|used)/.test(
                text
            )
        ) {
            challenges.push(
                'Did you call validate_claim or find_usages to verify zero callers? LLM reasoning about usage is unreliable — use LSP.'
            );
        }

        if (/count|off.?by.?one|incorrect\s*(number|count)/.test(text)) {
            challenges.push(
                'Did you enumerate the actual items to verify the count? Pattern-matching counts without enumeration is a top FP source.'
            );
        }

        if (challenges.length === 0) {
            return null;
        }

        // For high-severity findings, always challenge. For low, only when dismissive (prosecution).
        const isMediumPlus =
            args.severity === 'CRITICAL' ||
            args.severity === 'HIGH' ||
            args.severity === 'MEDIUM';
        if (!isMediumPlus && findingBias !== 'dismissive') {
            return null;
        }

        return (
            `⚠️ POST-RECORD VERIFICATION (answer before continuing):\n` +
            challenges.map((c) => `  • ${c}`).join('\n') +
            `\nIf you cannot answer YES with a specific tool call reference, call retract_finding for [${args.severity}] finding. ` +
            `Unverified findings damage review credibility.`
        );
    }
}
