import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import {
    FINDING_SEVERITIES,
    ALLOWED_FINDING_CATEGORIES,
} from '../types/findingTypes';
import type { ClaimType } from '../types/claimTypes';

const VALID_CLAIM_TYPES: readonly ClaimType[] = [
    'symbol_unused',
    'type_mismatch',
    'symbol_missing',
    'not_exported',
    'no_callers',
    'no_implementation',
] as const;

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
        category: z
            .enum(ALLOWED_FINDING_CATEGORIES)
            .describe(
                'Finding category. ALLOWED: logic_error (wrong logic, off-by-one, null deref), ' +
                    'security_vulnerability (injection, auth bypass, data exposure), ' +
                    'resource_leak (unclosed handles, memory/listener leaks), ' +
                    'api_misuse (wrong params, missing await, deprecated API), ' +
                    'error_handling_gap (missing catch at SYSTEM BOUNDARY like external API/user input — NOT internal functions), ' +
                    'data_integrity (lost data, silent truncation, wrong serialization), ' +
                    'regression_risk (change breaks existing behavior). ' +
                    'EXCLUDED categories that must NOT be reported: missing tests, missing documentation, ' +
                    'code style/naming, runtime type validation on internal statically-typed code, ' +
                    'concurrency guards in single-threaded runtimes, design pattern suggestions.'
            ),
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
        verifiable_claims: z
            .array(
                z.object({
                    claim_type: z.enum(
                        VALID_CLAIM_TYPES as unknown as [string, ...string[]]
                    ),
                    file: z.string(),
                    line: z.coerce.number(),
                    symbol: z.string(),
                    assertion: z.string(),
                })
            )
            .optional()
            .default([])
            .describe(
                'Claims verified via validate_claim tool. Each must reference a validate_claim call you made. ' +
                    'Example: [{claim_type: "no_callers", file: "src/auth.ts", line: 42, symbol: "hashPassword", assertion: "No callers handle the error from hashPassword"}]'
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

        // Calibration gate: enforce minimum investigation before first finding.
        // Only applies to the FIRST finding — once investigation is established,
        // subsequent findings don't need the gate.
        if (store.size === 0) {
            const minCalls =
                context.calibrationProfile.investigationProtocol
                    .minToolCallsBeforeFirstFinding;
            if (minCalls > 0) {
                // Count all tool calls excluding record_finding and retract_finding
                const excludedTools = new Set([
                    'record_finding',
                    'retract_finding',
                    'submit_review',
                ]);
                let investigationCalls = 0;
                for (const [toolName, count] of context.toolCallCounts) {
                    if (!excludedTools.has(toolName)) {
                        investigationCalls += count;
                    }
                }
                if (investigationCalls < minCalls) {
                    return toolError(
                        `Finding rejected: insufficient investigation (${investigationCalls} tool calls, minimum ${minCalls} required before first finding). ` +
                            'You must use investigation tools (get_file_diff, search_for_pattern, find_usages, validate_claim, etc.) ' +
                            'to understand the codebase BEFORE recording findings. Premature findings have a 90%+ false positive rate. ' +
                            'Go investigate more, then try again.'
                    );
                }
            }
        }

        if (context.parsedDiff) {
            const changedFiles = new Set(
                context.parsedDiff.map((d) => d.filePath)
            );
            const normalizedFile = args.file.replace(/\\/g, '/');
            const isInDiff =
                changedFiles.has(normalizedFile) ||
                [...changedFiles].some(
                    (f) =>
                        normalizedFile.endsWith(f) || f.endsWith(normalizedFile)
                );

            if (!isInDiff) {
                return toolError(
                    `Finding rejected: "${args.file}" is not in the changed files for this PR. ` +
                        'Only report issues in files that were modified in this PR. ' +
                        `Changed files: ${[...changedFiles].join(', ')}`
                );
            }
        }

        // File investigation gate: require that the model has actually investigated
        // the target file (via read_file, find_symbol, find_usages, or validate_claim)
        // before recording a finding. Prevents "drive-by" findings based only on
        // diff hunks without verifying claims against the actual codebase.
        if (context.investigatedFiles) {
            const normalizedFile = args.file.replace(/\\/g, '/');
            const hasInvestigated =
                context.investigatedFiles.has(normalizedFile) ||
                [...context.investigatedFiles].some(
                    (f) =>
                        normalizedFile.endsWith(f) || f.endsWith(normalizedFile)
                );

            if (!hasInvestigated) {
                return toolError(
                    `Finding rejected: you have not investigated "${args.file}" with read_file, find_symbol, find_usages, or validate_claim. ` +
                        'You MUST read the actual file or verify symbols before recording a finding — ' +
                        'findings based only on diff hunks have a 90%+ false positive rate. ' +
                        'Investigate the file first, then try recording again.'
                );
            }
        }

        const finding = store.record({
            agentId: context.currentAgentId ?? 'unknown',
            severity: args.severity,
            category: args.category,
            title: args.title,
            file: args.file,
            lineRange: [args.line, args.line],
            description: args.description,
            verificationEvidence: args.verification_evidence,
            supportingToolCalls: [],
            disproof: {
                attempted: true,
                method: args.disproof_note,
                result: args.disproof_note,
            },
            verifiableClaims: (args.verifiable_claims ?? []).map((c) => ({
                claimType: c.claim_type as ClaimType,
                file: c.file,
                line: c.line,
                symbol: c.symbol,
                assertion: c.assertion,
            })),
        });

        return toolSuccess(
            `Finding recorded: [${finding.id}] ${finding.severity} — ${finding.title}\n` +
                `Evidence: ${args.verification_evidence}\n` +
                `Disproof attempt: ${args.disproof_note}\n\n` +
                `LSP claims: ${args.verifiable_claims?.length ?? 0} attached for post-hoc validation\n\n` +
                `⚠️ MANDATORY SELF-CHECK before continuing:\n` +
                `1. Re-read your verification_evidence above. Does it cite a SPECIFIC tool output (not just reasoning)?\n` +
                `2. Could this be INTENTIONAL design? Did you search for comments, docs, or commit history explaining the rationale?\n` +
                `3. Is this MECHANICAL (provable by tools) or INTENT-BASED (requires knowing author's rationale)? Intent-based findings have the highest FP rate.\n` +
                `If the answer to #1 is NO, call retract_finding immediately.`
        );
    }
}
