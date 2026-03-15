import { Log } from './loggingService';
import type { RecordedFinding, FindingSeverity } from '../types/findingTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';
import type { InvestigationDepth } from '../types/investigationTypes';
import {
    INVESTIGATION_TOOLS,
    QUALITY_TOOLS,
    PR_CONTEXT_TOOLS,
    DIFF_TOOLS,
} from '../models/toolConstants';
import { buildInvestigationAudit } from '../utils/investigationAudit';

const DEPTH_THRESHOLD_HIGH = 4;
const DEPTH_THRESHOLD_MEDIUM = 2;

/**
 * All known tool names the model might reference in evidence text.
 * Derived from existing tool constant arrays to avoid maintaining a separate list.
 */
const ALL_TOOL_NAMES: readonly string[] = [
    ...INVESTIGATION_TOOLS,
    ...QUALITY_TOOLS,
    ...PR_CONTEXT_TOOLS,
    ...DIFF_TOOLS,
    'validate_claim',
    'run_subagent',
    'think',
];

export type EvidenceVerdict = 'keep' | 'drop' | 'downgrade';

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

        for (const finding of findings) {
            const entry = this.auditFinding(
                finding,
                toolCallRecords,
                investigationAudit.depthScores
            );
            entries.push(entry);
        }

        const dropped = entries.filter((e) => e.verdict === 'drop').length;
        const downgraded = entries.filter(
            (e) => e.verdict === 'downgrade'
        ).length;
        const kept = entries.filter((e) => e.verdict === 'keep').length;

        Log.info(
            `EvidenceAuditor: ${kept} kept, ${downgraded} downgraded, ${dropped} dropped out of ${findings.length} findings`
        );

        return { entries, dropped, downgraded, kept };
    }

    private auditFinding(
        finding: RecordedFinding,
        toolCallRecords: ToolCallRecord[],
        depthScores: Map<string, InvestigationDepth>
    ): EvidenceAuditEntry {
        // Step 1: Find all tool calls that reference the finding's file
        const matchingCalls = this.findToolCallsForFile(
            finding.file,
            toolCallRecords
        );

        const supportingToolCallIds = matchingCalls.map((tc) => tc.id);
        const actualToolsOnFile = [
            ...new Set(matchingCalls.map((tc) => tc.toolName)),
        ];

        // Step 2: Extract tool names claimed in evidence text
        const evidenceText = this.getEvidenceText(finding);
        const claimedTools = extractClaimedToolNames(evidenceText);

        // Step 3: Populate supportingToolCalls on the finding
        finding.supportingToolCalls = supportingToolCallIds;

        // Step 4: Check for fabricated evidence
        if (claimedTools.length > 0) {
            const fabricated = this.findFabricatedClaims(
                claimedTools,
                matchingCalls,
                toolCallRecords
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
                    supportingToolCallIds,
                    claimedTools,
                    actualToolsOnFile,
                };
            }
        }

        // Step 5: Check investigation depth using scored depth system
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
                supportingToolCallIds,
                claimedTools,
                actualToolsOnFile,
            };
        }

        return {
            finding,
            verdict: 'keep',
            reason: undefined,
            supportingToolCallIds,
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
        const normalizedTarget = findingFile.replace(/\\/g, '/');

        return toolCallRecords.filter((tc) => {
            if (!tc.success) {
                return false;
            }

            const files = extractFilesFromArgs(tc.arguments);
            return files.some((f) => {
                const normalizedFile = f.replace(/\\/g, '/');
                return (
                    normalizedFile === normalizedTarget ||
                    normalizedFile.endsWith(normalizedTarget) ||
                    normalizedTarget.endsWith(normalizedFile)
                );
            });
        });
    }

    /**
     * Check which claimed tools were never actually called on the finding's file.
     * A tool is considered fabricated if:
     * - It was mentioned in evidence text
     * - It was never called at all, OR it was called but not on this file
     */
    private findFabricatedClaims(
        claimedTools: string[],
        fileMatchingCalls: ToolCallRecord[],
        allToolCallRecords: ToolCallRecord[]
    ): string[] {
        const toolsCalledOnFile = new Set(
            fileMatchingCalls.map((tc) => tc.toolName)
        );
        const allToolsEverCalled = new Set(
            allToolCallRecords
                .filter((tc) => tc.success)
                .map((tc) => tc.toolName)
        );

        return claimedTools.filter((claimed) => {
            // Tool was called on this specific file → not fabricated
            if (toolsCalledOnFile.has(claimed)) {
                return false;
            }
            // Tool was never called at all → fabricated
            if (!allToolsEverCalled.has(claimed)) {
                return true;
            }
            // Tool was called on OTHER files but not this one → fabricated for this file
            return true;
        });
    }

    private getFileDepthScore(
        file: string,
        depthScores: Map<string, InvestigationDepth>
    ): number {
        const normalized = file.replace(/\\/g, '/');

        const exact = depthScores.get(normalized);
        if (exact) {
            return exact.score;
        }

        for (const [path, depth] of depthScores) {
            if (path.endsWith(normalized) || normalized.endsWith(path)) {
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

    private getEvidenceText(finding: RecordedFinding): string {
        const parts: string[] = [finding.description];
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
 * Extract tool names mentioned in evidence text.
 * Looks for known tool names as identifiers (not substrings of other words).
 */
export function extractClaimedToolNames(text: string): string[] {
    if (!text) {
        return [];
    }

    const found: string[] = [];
    const lowerText = text.toLowerCase();

    for (const toolName of ALL_TOOL_NAMES) {
        // Match the tool name as a word boundary or followed by ( or space
        // This avoids partial matches like "find_files_by_pattern" matching "find"
        const pattern = new RegExp(
            `\\b${toolName.replace(/_/g, '[_ ]')}\\b|${toolName.replace(/_/g, '[_ ]')}\\(`,
            'i'
        );
        if (pattern.test(lowerText)) {
            found.push(toolName);
        }
    }

    return found;
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
            if (typeof fp === 'string' && fp.length > 0) {
                files.push(fp);
            }
        }
    }

    return files;
}
