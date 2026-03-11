import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import { FINDING_SEVERITIES } from '../types/findingTypes';

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
            .pipe(z.enum(FINDING_SEVERITIES))
            .describe('Finding severity: CRITICAL, HIGH, MEDIUM, or LOW'),
        title: z.string().describe('Brief finding title'),
        file: z.string().describe('Primary file path affected'),
        line: z.coerce.number().describe('Primary line number (1-indexed)'),
        description: z
            .string()
            .describe(
                'Detailed description: what is wrong, what tool calls confirmed it, and what could go wrong'
            ),
        verification_evidence: z
            .string()
            .min(10)
            .describe(
                'REQUIRED: Which specific tool call confirmed this? Name the tool, what you queried, and what the output showed. ' +
                    'Example: "find_usages(login, auth.ts) returned 3 callers — none hash the password before calling". ' +
                    'If you cannot cite a specific tool output, do NOT record this finding.'
            ),
        disproof_note: z
            .string()
            .min(10)
            .describe(
                'REQUIRED: How you tried to disprove this finding and why it survived. ' +
                    'Example: "Checked callers with find_usages — all 3 callers pass unvalidated input. ' +
                    'Searched for upstream validation with search_for_pattern — none found."'
            ),
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
                attempted: true,
                method: args.disproof_note,
                result: args.disproof_note,
            },
            verifiableClaims: [],
        });

        return toolSuccess(
            `Finding recorded: [${finding.id}] ${finding.severity} — ${finding.title}\n` +
                `Evidence: ${args.verification_evidence}\n` +
                `Disproof attempt: ${args.disproof_note}\n\n` +
                `⚠️ MANDATORY SELF-CHECK before continuing:\n` +
                `1. Re-read your verification_evidence above. Does it cite a SPECIFIC tool output (not just reasoning)?\n` +
                `2. Could this be INTENTIONAL design? Did you search for comments, docs, or commit history explaining the rationale?\n` +
                `3. Is this MECHANICAL (provable by tools) or INTENT-BASED (requires knowing author's rationale)? Intent-based findings have the highest FP rate.\n` +
                `If the answer to #1 is NO, call retract_finding immediately.`
        );
    }
}
