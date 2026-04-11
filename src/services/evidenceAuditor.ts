import { Log } from './loggingService';
import type { RecordedFinding, FindingSeverity } from '../types/findingTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';
import type { InvestigationDepth } from '../types/investigationTypes';
import { INVESTIGATION_TOOLS, DIFF_TOOLS } from '../models/toolConstants';
import {
    buildInvestigationAudit,
    flattenToolCalls,
} from '../utils/investigationAudit';

function normalizeRelativePath(p: string): string {
    const slashNormalized = p.replace(/\\/g, '/').replace(/^\.\//, '');
    // Collapse internal ./ and ../ segments
    const segments = slashNormalized.split('/');
    const resolved: string[] = [];
    for (const seg of segments) {
        if (seg === '.') {
            continue;
        }
        if (
            seg === '..' &&
            resolved.length > 0 &&
            resolved[resolved.length - 1] !== '..'
        ) {
            resolved.pop();
        } else {
            resolved.push(seg);
        }
    }
    return resolved.join('/');
}

const DEPTH_THRESHOLD_HIGH = 4;
const DEPTH_THRESHOLD_MEDIUM = 2;
const MIN_IDENTIFIER_LENGTH = 3;

/**
 * Tool argument keys that reference symbols (not file paths).
 */
const SYMBOL_ARG_KEYS = ['symbol_name', 'name', 'name_path'] as const;

const DELETION_LANGUAGE_PATTERN =
    /\b(deleted|removed|no longer|was removed|was deleted|dropped|eliminated|got rid of)\b/i;

const ZERO_REFERENCE_PATTERNS = [
    /0 results/i,
    /no results/i,
    /not found/i,
    /no references/i,
    /0 usages/i,
    /no usages/i,
    /no callers/i,
    /0 callers/i,
    /no matches/i,
    /0 matches/i,
    /no occurrences/i,
    /0 occurrences/i,
] as const;

const ZERO_REFERENCE_TOOL_NAMES = new Set(['find_usages', 'find_symbol']);

/**
 * Tools that target specific files and can be matched per-file.
 * Excludes non-investigation tools (validate_claim, retract_finding, think, etc.)
 * and global tools (search_for_pattern) that don't target a single file.
 */
const FILE_TARGETED_TOOL_NAMES: readonly string[] = [
    ...new Set([
        ...INVESTIGATION_TOOLS.filter(
            (t) =>
                t !== 'search_for_pattern' &&
                t !== 'batch_tools' &&
                t !== 'find_files_by_pattern'
        ),
        ...DIFF_TOOLS,
    ]),
];

/**
 * Pattern matching findings that claim callers/consumers exist and do/don't do something.
 */
const CALLER_CLAIM_PATTERN =
    /\b(?:callers?|call[\s-]*sites?|consumers?|upstream\s+code)\b/;

/**
 * Pattern matching findings that explicitly state there are no callers.
 * Used to exclude "no callers" findings from the caller claim contradiction check.
 */
const NO_CALLERS_PATTERN =
    /\b(?:no|zero|0|unused|dead|orphan)\s+(?:callers?|references?|usages?|consumers?)\b/;

/**
 * Pattern matching findings that claim something about a function's internal behavior.
 */
const FUNCTION_BEHAVIOR_PATTERN =
    /\b(?:doesn't|does not|don't|do not|fails? to|missing|lacks?|no|incorrectly|improperly|unsafely|wrongly|(?:is|are|was|were)\s+not)\s+(?:handl|check|validat|verif|sanitiz|escap|guard|protect|catch|throw|return|log(?!ic)|clos|releas|dispos|clean|clear(?!ly)|free(?!z)|initializ|init(?!ial)|deserializ|pars|process|encod|decod)\w*\b/;

export type EvidenceVerdict = 'keep' | 'drop' | 'downgrade' | 'weak-evidence';

export interface EvidenceAuditEntry {
    finding: RecordedFinding;
    verdict: EvidenceVerdict;
    reason: string | undefined;
    supportingToolCallIds: string[];
    claimedTools: string[];
    actualToolsOnFile: string[];
}

export interface EvidenceAuditResult {
    entries: EvidenceAuditEntry[];
    dropped: number;
    downgraded: number;
    weakEvidence: number;
    kept: number;
}

/**
 * Audits findings against actual tool call records to detect fabricated evidence.
 *
 * The model records findings with `verificationEvidence` describing
 * which tools it claims to have used. This auditor cross-references those
 * claims against the actual ToolCallRecord history to catch:
 *
 * 1. Fabricated evidence: model claims tools it never called
 * 2. Insufficient investigation: HIGH+ findings with only shallow tool use
 * 3. Missing file-level investigation: no investigation tools targeted the file
 *
 * Also populates `supportingToolCalls` on each finding with IDs of
 * matching tool call records for downstream validators.
 */
export class EvidenceAuditor {
    audit(
        findings: RecordedFinding[],
        toolCallRecords: ToolCallRecord[]
    ): EvidenceAuditResult {
        const entries: EvidenceAuditEntry[] = [];
        const investigationAudit = buildInvestigationAudit(toolCallRecords);
        const flatRecords = flattenToolCalls(toolCallRecords);

        for (const finding of findings) {
            const entry = this.auditFinding(
                finding,
                flatRecords,
                investigationAudit.depthScores
            );
            entries.push(entry);
        }

        const dropped = entries.filter((e) => e.verdict === 'drop').length;
        const downgraded = entries.filter(
            (e) => e.verdict === 'downgrade'
        ).length;
        const kept = entries.filter((e) => e.verdict === 'keep').length;
        const weakEvidence = entries.filter(
            (e) => e.verdict === 'weak-evidence'
        ).length;

        Log.info(
            `EvidenceAuditor: ${kept} kept, ${downgraded} downgraded, ${weakEvidence} weak-evidence, ${dropped} dropped out of ${findings.length} findings`
        );

        return { entries, dropped, downgraded, weakEvidence, kept };
    }

    private auditFinding(
        finding: RecordedFinding,
        flatRecords: ToolCallRecord[],
        depthScores: Map<string, InvestigationDepth>
    ): EvidenceAuditEntry {
        const matchingCalls = this.findToolCallsForFile(
            finding.file,
            flatRecords
        );

        const globalSearchCalls = this.findGlobalSearchCallsMentioningFile(
            finding.file,
            flatRecords
        );
        const allSupportingCalls = [...matchingCalls, ...globalSearchCalls];
        const supportingToolCallIdsAll = [
            ...new Set(allSupportingCalls.map((tc) => tc.id)),
        ];

        const evidenceText = this.getEvidenceText(finding);
        const claimedTools = extractClaimedToolNames(evidenceText);

        const actualToolsOnFile = [
            ...new Set(allSupportingCalls.map((tc) => tc.toolName)),
        ];

        finding.supportingToolCalls = supportingToolCallIdsAll;

        const deletionVerdict = this.checkDeletionSafety(
            finding,
            allSupportingCalls
        );
        if (deletionVerdict) {
            return {
                ...deletionVerdict,
                supportingToolCallIds: supportingToolCallIdsAll,
                claimedTools,
                actualToolsOnFile,
            };
        }

        if (claimedTools.length > 0) {
            const fabricated = this.findFabricatedClaims(
                claimedTools,
                allSupportingCalls
            );
            if (fabricated.length > 0) {
                const reason = `Fabricated evidence: claimed ${fabricated.join(', ')} but ${fabricated.length === 1 ? 'this tool was' : 'these tools were'} never called on "${finding.file}"`;
                Log.info(
                    `EvidenceAuditor DROP [${finding.id}] "${finding.title}": ${reason}`
                );
                return {
                    finding,
                    verdict: 'drop',
                    reason,
                    supportingToolCallIds: supportingToolCallIdsAll,
                    claimedTools,
                    actualToolsOnFile,
                };
            }
        }

        const fileScore = this.getFileDepthScore(finding.file, depthScores);
        const requiredScore = this.getRequiredDepthScore(finding.severity);

        if (requiredScore > 0 && fileScore < requiredScore) {
            const reason = `${finding.severity} finding has depth score ${fileScore} but requires ≥${requiredScore}`;
            Log.info(
                `EvidenceAuditor DOWNGRADE [${finding.id}] "${finding.title}": ${reason}`
            );
            return {
                finding,
                verdict: 'downgrade',
                reason,
                supportingToolCallIds: supportingToolCallIdsAll,
                claimedTools,
                actualToolsOnFile,
            };
        }

        const patternVerdict = this.checkPatternSpecificEvidence(
            finding,
            allSupportingCalls
        );
        if (patternVerdict) {
            return {
                ...patternVerdict,
                supportingToolCallIds: supportingToolCallIdsAll,
                claimedTools,
                actualToolsOnFile,
            };
        }

        const claimVerdict = this.checkClaimVsOutput(
            finding,
            allSupportingCalls
        );
        if (claimVerdict) {
            return {
                ...claimVerdict,
                supportingToolCallIds: supportingToolCallIdsAll,
                claimedTools,
                actualToolsOnFile,
            };
        }

        return {
            finding,
            verdict: 'keep',
            reason: undefined,
            supportingToolCallIds: supportingToolCallIdsAll,
            claimedTools,
            actualToolsOnFile,
        };
    }

    /**
     * Find all tool call records that reference a specific file.
     * Checks common argument fields: file_path, file, file_paths, relative_path.
     */
    private findToolCallsForFile(
        findingFile: string,
        toolCallRecords: ToolCallRecord[]
    ): ToolCallRecord[] {
        const normalizedTarget = normalizeRelativePath(findingFile);

        return toolCallRecords.filter((tc) => {
            if (!tc.success) {
                return false;
            }

            const files = extractFilesFromArgs(tc.arguments);
            return files.some((f) => {
                const normalizedFile = normalizeRelativePath(f);
                return (
                    normalizedFile === normalizedTarget ||
                    normalizedFile.endsWith('/' + normalizedTarget) ||
                    normalizedTarget.endsWith('/' + normalizedFile)
                );
            });
        });
    }

    /**
     * Find global search tool calls (e.g. search_for_pattern) whose results
     * mention the finding's file. These tools don't have a file_path argument
     * so they can't be matched by `findToolCallsForFile`, but their results
     * may reference the file, making them valid supporting evidence.
     *
     * Only matches when the full relative path appears in the result text.
     * Bare filename matching (e.g. just "helper.ts") is intentionally avoided
     * because same-named files in different directories would produce false matches,
     * masking fabrication detection.
     */
    private findGlobalSearchCallsMentioningFile(
        findingFile: string,
        toolCallRecords: ToolCallRecord[]
    ): ToolCallRecord[] {
        const normalizedTarget = normalizeRelativePath(findingFile);

        return toolCallRecords.filter((tc) => {
            if (!tc.success || typeof tc.result !== 'string') {
                return false;
            }
            if (tc.toolName !== 'search_for_pattern') {
                return false;
            }
            const normalizedResult = tc.result
                .replace(/\\/g, '/')
                .replace(/\.\/(?=\w)/g, '');
            // Require a path boundary after the match to prevent
            // prefix false positives (e.g. 'src/foo.ts' matching 'src/foo.tsx')
            let searchFrom = 0;
            while (true) {
                const idx = normalizedResult.indexOf(
                    normalizedTarget,
                    searchFrom
                );
                if (idx === -1) {
                    return false;
                }
                // Left boundary: must be at start or preceded by a path separator/whitespace
                const leftOk =
                    idx === 0 ||
                    /[/ \t\n\r"',;>()[\]{}]/.test(normalizedResult[idx - 1]!);
                if (!leftOk) {
                    searchFrom = idx + 1;
                    continue;
                }
                const afterMatch = idx + normalizedTarget.length;
                if (afterMatch >= normalizedResult.length) {
                    return true;
                }
                const nextChar = normalizedResult[afterMatch]!;
                if (/[:, \t\n\r"';)<[\]{}]/.test(nextChar)) {
                    return true;
                }
                searchFrom = idx + 1;
            }
        });
    }

    /**
     * Check which claimed tools were never actually called on the finding's file.
     * Only checks file-targeted investigation tools — non-file tools
     * (validate_claim, think, etc.) and global tools (search_for_pattern)
     * are excluded since they can't be matched to a specific file.
     *
     * A finding is only flagged as fabricated if:
     * - It claims file-targeted tools that were never called on the file
     * - AND no other investigation tools were called on the file either
     *   (if the file WAS investigated, misattributing which tool found it is
     *   an evidence quality issue, not fabrication)
     */
    private findFabricatedClaims(
        claimedTools: string[],
        fileSupportingCalls: ToolCallRecord[]
    ): string[] {
        // Only check file-targeted tools, not validate_claim/think/etc.
        const fileTargetedClaims = claimedTools.filter((t) =>
            FILE_TARGETED_TOOL_NAMES.includes(t)
        );
        if (fileTargetedClaims.length === 0) {
            return [];
        }

        const toolsOnFile = new Set(
            fileSupportingCalls.map((tc) => tc.toolName)
        );

        // If the file was investigated by ANY tool, don't flag as fabricated.
        // The model found the issue — it just misattributed which tool it used.
        if (toolsOnFile.size > 0) {
            return [];
        }

        // No tools called on this file at all — all claimed file-targeted tools are fabricated
        return fileTargetedClaims;
    }

    /**
     * Check whether a finding about deleted/removed code was proven safe.
     *
     * Only triggers when ALL conditions are met:
     * 1. Evidence text mentions deletion/removal
     * 2. A reference-checking tool (find_usages, find_symbol) was called
     *    specifically for this finding's file and returned zero references
     * 3. The finding is NOT about test coverage or test removal
     *    (zero references for a deleted test is expected, not proof of safety)
     */
    private checkDeletionSafety(
        finding: RecordedFinding,
        fileSupportingCalls: ToolCallRecord[]
    ): Pick<EvidenceAuditEntry, 'finding' | 'verdict' | 'reason'> | null {
        const evidenceText = this.getEvidenceText(finding);

        if (!DELETION_LANGUAGE_PATTERN.test(evidenceText)) {
            return null;
        }

        // Don't drop test coverage/removal findings — zero refs is expected for deleted tests
        if (this.isTestCoverageFinding(finding)) {
            return null;
        }

        // Only check reference tools called on THIS finding's file, not all records
        const referenceToolCalls = fileSupportingCalls.filter(
            (tc) =>
                tc.success &&
                ZERO_REFERENCE_TOOL_NAMES.has(tc.toolName) &&
                typeof tc.result === 'string'
        );

        const hasZeroReferences = referenceToolCalls.some((tc) =>
            ZERO_REFERENCE_PATTERNS.some((pattern) =>
                pattern.test(tc.result as string)
            )
        );

        if (!hasZeroReferences) {
            return null;
        }

        const reason =
            'Deletion safety: evidence mentions removal AND tool calls show zero references/callers';
        Log.info(
            `EvidenceAuditor DROP [${finding.id}] "${finding.title}": ${reason}`
        );
        return { finding, verdict: 'drop', reason };
    }

    private isTestCoverageFinding(finding: RecordedFinding): boolean {
        if (/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(finding.file)) {
            return true;
        }
        const text = `${finding.title} ${finding.description}`.toLowerCase();
        return /\buntested\b|\bcoverage\s+(gap|loss|miss|reduc)|\btests?\s+(remov|delet|drop)|\btest\s+file\s+(remov|delet)/.test(
            text
        );
    }

    private getFileDepthScore(
        file: string,
        depthScores: Map<string, InvestigationDepth>
    ): number {
        const normalized = normalizeRelativePath(file);

        const exact = depthScores.get(normalized);
        if (exact) {
            return exact.score;
        }

        for (const [path, depth] of depthScores) {
            if (
                path.endsWith('/' + normalized) ||
                normalized.endsWith('/' + path)
            ) {
                return depth.score;
            }
        }

        return 0;
    }

    private getRequiredDepthScore(severity: FindingSeverity): number {
        switch (severity) {
            case 'CRITICAL':
            case 'HIGH':
                return DEPTH_THRESHOLD_HIGH;
            case 'MEDIUM':
                return DEPTH_THRESHOLD_MEDIUM;
            case 'LOW':
                return 0;
        }
    }

    /**
     * Cross-reference identifiers mentioned in the finding against actual tool output text.
     * If the finding's primary identifier (from affectedComponent) doesn't appear in any
     * tool output for the file, the evidence is weak — the model may have fabricated the conclusion.
     *
     * Only runs for MEDIUM+ severity findings that have supporting tool calls.
     * Conservative: only flags when the primary identifier is clearly absent.
     */
    private checkClaimVsOutput(
        finding: RecordedFinding,
        fileSupportingCalls: ToolCallRecord[]
    ): Pick<EvidenceAuditEntry, 'finding' | 'verdict' | 'reason'> | null {
        // Only check MEDIUM+ severity — LOW findings are too noisy
        if (finding.severity === 'LOW') {
            return null;
        }

        // Must have supporting tool calls (tools were called on this file)
        if (fileSupportingCalls.length === 0) {
            return null;
        }

        // Extract the primary identifier from affectedComponent
        const primaryIdentifier = extractPrimaryIdentifier(
            finding.affectedComponent
        );
        if (!primaryIdentifier) {
            return null;
        }

        // Aggregate all tool output text from supporting calls
        const outputText = aggregateToolOutputText(fileSupportingCalls);
        if (outputText.length === 0) {
            return null;
        }

        // Check if the primary identifier appears in any tool output
        if (outputText.includes(primaryIdentifier)) {
            return null;
        }

        const reason = `Weak evidence: claimed symbol "${primaryIdentifier}" not found in any tool output for "${finding.file}"`;
        Log.info(
            `EvidenceAuditor WEAK-EVIDENCE [${finding.id}] "${finding.title}": ${reason}`
        );
        return { finding, verdict: 'weak-evidence', reason };
    }

    /**
     * Pattern-specific evidence checks for common false positive patterns.
     * Each check targets a specific claim type and verifies the tool output supports it.
     */
    private checkPatternSpecificEvidence(
        finding: RecordedFinding,
        fileSupportingCalls: ToolCallRecord[]
    ): Pick<EvidenceAuditEntry, 'finding' | 'verdict' | 'reason'> | null {
        // Only check MEDIUM+ severity
        if (finding.severity === 'LOW') {
            return null;
        }

        const text = `${finding.title} ${finding.description}`.toLowerCase();

        // Pattern 1: Finding claims callers exist/mishandle something,
        // but find_usages returned zero results
        const callerVerdict = this.checkCallerClaimContradiction(
            finding,
            text,
            fileSupportingCalls
        );
        if (callerVerdict) {
            return callerVerdict;
        }

        // Pattern 2: Finding claims about internal function behavior
        // but no read_file output contains the function name
        const bodyVerdict = this.checkFunctionBodyNotRead(
            finding,
            text,
            fileSupportingCalls
        );
        if (bodyVerdict) {
            return bodyVerdict;
        }

        return null;
    }

    /**
     * Detects contradiction: finding claims callers exist and mishandle something,
     * but find_usages actually returned zero results.
     *
     * Examples of claims this catches:
     * - "Callers don't handle the error return"
     * - "Call sites ignore the null case"
     * - "Consumers pass invalid arguments"
     */
    private checkCallerClaimContradiction(
        finding: RecordedFinding,
        lowerText: string,
        fileSupportingCalls: ToolCallRecord[]
    ): Pick<EvidenceAuditEntry, 'finding' | 'verdict' | 'reason'> | null {
        // Check if finding mentions callers/consumers
        if (!CALLER_CLAIM_PATTERN.test(lowerText)) {
            return null;
        }

        // If the finding explicitly says "no callers"/"unused", that's a different claim — skip
        if (NO_CALLERS_PATTERN.test(lowerText)) {
            return null;
        }

        // Check if find_usages was called on this file
        const allUsageCalls = fileSupportingCalls.filter(
            (tc) =>
                tc.success &&
                tc.toolName === 'find_usages' &&
                typeof tc.result === 'string'
        );

        if (allUsageCalls.length === 0) {
            return null;
        }

        // Filter to only find_usages calls targeting the claimed symbol
        const primaryIdentifier = extractPrimaryIdentifier(
            finding.affectedComponent
        );
        if (!primaryIdentifier) {
            return null;
        }
        const usageCalls = allUsageCalls.filter((tc) => {
            const symbolArg = SYMBOL_ARG_KEYS.map(
                (key) => tc.arguments[key]
            ).find((val): val is string => typeof val === 'string');
            return (
                symbolArg !== undefined &&
                (symbolArg === primaryIdentifier ||
                    symbolArg.endsWith('.' + primaryIdentifier))
            );
        });

        if (usageCalls.length === 0) {
            return null;
        }

        // Check if ALL find_usages calls returned zero results
        const allZero = usageCalls.every((tc) =>
            ZERO_REFERENCE_PATTERNS.some((pattern) =>
                pattern.test(tc.result as string)
            )
        );

        if (!allZero) {
            return null;
        }

        const reason =
            'Weak evidence: finding claims callers/consumers exist, but find_usages returned zero results';
        Log.info(
            `EvidenceAuditor WEAK-EVIDENCE [${finding.id}] "${finding.title}": ${reason}`
        );
        return { finding, verdict: 'weak-evidence', reason };
    }

    /**
     * Detects unsupported function behavior claims: finding claims something about
     * a function's internal behavior but no read_file output for the file
     * contains the function name, suggesting the function body was never actually read.
     */
    private checkFunctionBodyNotRead(
        finding: RecordedFinding,
        lowerText: string,
        fileSupportingCalls: ToolCallRecord[]
    ): Pick<EvidenceAuditEntry, 'finding' | 'verdict' | 'reason'> | null {
        // Check if finding makes a claim about internal function behavior
        if (!FUNCTION_BEHAVIOR_PATTERN.test(lowerText)) {
            return null;
        }

        // Extract the function name from affectedComponent
        const funcName = extractPrimaryIdentifier(finding.affectedComponent);
        if (!funcName) {
            return null;
        }

        // Check read_file calls specifically (primary source for function body)
        const readFileCalls = fileSupportingCalls.filter(
            (tc) =>
                tc.success &&
                tc.toolName === 'read_file' &&
                typeof tc.result === 'string'
        );

        // Also check get_file_diff — diffs can show the function implementation
        const diffCalls = fileSupportingCalls.filter(
            (tc) =>
                tc.success &&
                tc.toolName === 'get_file_diff' &&
                typeof tc.result === 'string'
        );

        // Function name must appear in at least one read_file or get_file_diff output
        const funcInReadFile = readFileCalls.some((tc) =>
            (tc.result as string).includes(funcName)
        );
        const funcInDiff = diffCalls.some((tc) =>
            (tc.result as string).includes(funcName)
        );

        if (funcInReadFile || funcInDiff) {
            return null;
        }

        // No tool output shows the function body
        if (readFileCalls.length === 0 && diffCalls.length === 0) {
            const reason = `Weak evidence: finding claims "${funcName}" has behavior issue, but no read_file or get_file_diff call was made on "${finding.file}"`;
            Log.info(
                `EvidenceAuditor WEAK-EVIDENCE [${finding.id}] "${finding.title}": ${reason}`
            );
            return { finding, verdict: 'weak-evidence', reason };
        }

        const reason = `Weak evidence: finding claims "${funcName}" has behavior issue, but function name not found in read_file or diff output`;
        Log.info(
            `EvidenceAuditor WEAK-EVIDENCE [${finding.id}] "${finding.title}": ${reason}`
        );
        return { finding, verdict: 'weak-evidence', reason };
    }

    private getEvidenceText(finding: RecordedFinding): string {
        const parts: string[] = [finding.title, finding.description];
        if (finding.verificationEvidence) {
            parts.push(finding.verificationEvidence);
        }
        if (finding.disproof.method) {
            parts.push(finding.disproof.method);
        }
        if (
            finding.disproof.result &&
            finding.disproof.result !== finding.disproof.method
        ) {
            parts.push(finding.disproof.result);
        }
        return parts.join(' ');
    }
}

/**
 * Extract file-targeted investigation tool names mentioned in evidence text.
 * Only returns tools that target specific files (read_file, find_usages, etc.).
 * Excludes non-investigation tools (validate_claim, think, record_finding, etc.)
 * and global search tools (search_for_pattern) since they can't be matched per-file.
 */
export function extractClaimedToolNames(text: string): string[] {
    if (!text) {
        return [];
    }

    const found: string[] = [];
    const lowerText = text.toLowerCase();

    for (const toolName of FILE_TARGETED_TOOL_NAMES) {
        // Match the tool name as a word boundary or followed by ( or space
        // This avoids partial matches like "find_files_by_pattern" matching "find"
        const pattern = new RegExp(
            `\\b${toolName.replace(/_/g, '[_ ]')}(?:\\b|\\()`,
            'i'
        );
        if (pattern.test(lowerText)) {
            found.push(toolName);
        }
    }

    return found;
}

/**
 * Extract the primary identifier from the affectedComponent field.
 * Strips trailing parentheses, splits by dots, and returns the last (most specific) part.
 * Returns undefined if the input is empty or the result is too short.
 */
export function extractPrimaryIdentifier(
    affectedComponent: string | undefined
): string | undefined {
    if (!affectedComponent) {
        return undefined;
    }

    // Strip trailing parenthesized content (handles both () and (args))
    const cleaned = affectedComponent.replace(/\(.*\)$/, '').trim();
    if (cleaned.length < MIN_IDENTIFIER_LENGTH) {
        return undefined;
    }

    // Split by dots and take the last part (most specific symbol)
    const parts = cleaned.split('.');
    const last = parts[parts.length - 1]!;

    // If the last part is too short, skip the check rather than
    // searching for the full dotted string (which includes a literal dot)
    return last.length >= MIN_IDENTIFIER_LENGTH ? last : undefined;
}

/**
 * Aggregate tool output text from a set of tool call records.
 * Only includes string results from successful calls.
 */
export function aggregateToolOutputText(toolCalls: ToolCallRecord[]): string {
    return toolCalls
        .filter((tc) => tc.success && typeof tc.result === 'string')
        .map((tc) => tc.result as string)
        .join('\n');
}

/**
 * Extract file paths from tool call arguments.
 * Handles various argument naming conventions across tools.
 */
export function extractFilesFromArgs(args: Record<string, unknown>): string[] {
    const files: string[] = [];

    // Direct file arguments
    for (const key of ['file_path', 'file', 'path', 'relative_path']) {
        const value = args[key];
        if (typeof value === 'string' && value !== '.' && value.length > 0) {
            files.push(value);
        }
    }

    // Array file arguments (e.g., get_file_diff's file_paths)
    const filePaths = args['file_paths'];
    if (Array.isArray(filePaths)) {
        for (const fp of filePaths) {
            if (typeof fp === 'string' && fp.length > 0 && fp !== '.') {
                files.push(fp);
            }
        }
    }

    return files;
}
