/**
 * Tracks reasoning hypotheses across think tool calls within an analysis session.
 * Provides continuity: hypotheses generated at checkpoint 1 are tracked through
 * investigation and resolution at later checkpoints.
 */

/** Status of a hypothesis in the reasoning chain */
export type HypothesisStatus =
    | 'generated'
    | 'investigating'
    | 'confirmed'
    | 'dismissed'
    | 'abandoned';

/** A single hypothesis tracked through the analysis */
export interface TrackedHypothesis {
    /** Unique ID (auto-incremented) */
    readonly id: number;
    /** The risk/hypothesis text from identified_risks */
    readonly text: string;
    /** Which think checkpoint generated this */
    readonly generatedAtCheckpoint: number;
    /** Current status */
    status: HypothesisStatus;
    /** Checkpoint where status last changed */
    lastUpdatedAtCheckpoint: number;
    /** Tool calls made to investigate (tool names) */
    investigationTools: string[];
    /** Resolution note (why confirmed/dismissed/abandoned) */
    resolutionNote?: string;
    /** Finding ID that confirmed this hypothesis (set by record_finding, used by retract_finding) */
    confirmedByFindingId?: string;
}

/** Summary of a think checkpoint */
export interface ThinkCheckpoint {
    /** Sequential checkpoint number (1-based) */
    readonly number: number;
    /** Topic from the think call */
    readonly topic: string;
    /** Hypotheses generated at this checkpoint */
    readonly hypothesesGenerated: number[];
    /** Tool calls made since previous checkpoint */
    readonly toolCallsSincePrevious: string[];
    /** Count of investigation tools since previous checkpoint */
    readonly investigationToolCount: number;
}

/**
 * Tools considered "investigation" tools for evidence-aware gating.
 * Used to auto-transition hypotheses (generated→investigating) and count evidence gathering.
 * NOTE: Different from INVESTIGATION_TOOLS in toolConstants.ts which is used for
 * tool access control in recursive mode. The sets intentionally differ:
 * - This set includes validate_claim (evidence gathering) and excludes batch_tools (meta-tool)
 * - toolConstants.ts includes batch_tools (access control) and excludes validate_claim
 */
const INVESTIGATION_TOOLS = new Set([
    'find_usages',
    'find_symbol',
    'read_file',
    'search_for_pattern',
    'validate_claim',
    'get_file_diff',
    'get_symbols_overview',
    'find_files_by_pattern',
]);

export class ReasoningChain {
    private hypotheses: TrackedHypothesis[] = [];
    private checkpoints: ThinkCheckpoint[] = [];
    private nextHypothesisId = 1;
    private toolCallsSinceLastCheckpoint: string[] = [];

    /** Get the current checkpoint number (1-based, minimum 1 even before first checkpoint) */
    private getCurrentCheckpointNumber(): number {
        return Math.max(1, this.checkpoints.length);
    }

    /** Record a tool call (called by ToolExecutor on each tool execution) */
    recordToolCall(toolName: string): void {
        this.toolCallsSinceLastCheckpoint.push(toolName);

        // Auto-transition hypotheses when investigation tools are called
        if (INVESTIGATION_TOOLS.has(toolName)) {
            for (const h of this.hypotheses) {
                if (h.status === 'generated') {
                    h.status = 'investigating';
                    h.lastUpdatedAtCheckpoint =
                        this.getCurrentCheckpointNumber();
                }
                if (h.status === 'investigating') {
                    h.investigationTools.push(toolName);
                }
            }
        }
    }

    /** Get tools called since the last think checkpoint */
    getToolCallsSinceLastCheckpoint(): readonly string[] {
        return this.toolCallsSinceLastCheckpoint;
    }

    /** Count investigation tools called since last checkpoint */
    getInvestigationToolCountSinceLastCheckpoint(): number {
        return this.toolCallsSinceLastCheckpoint.filter((t) =>
            INVESTIGATION_TOOLS.has(t)
        ).length;
    }

    /** Record a think checkpoint with new hypotheses */
    addCheckpoint(topic: string, risks: string[]): ThinkCheckpoint {
        const checkpointNumber = this.checkpoints.length + 1;
        const hypothesisIds: number[] = [];

        for (const risk of risks) {
            if (!risk.trim()) {
                continue;
            }

            // Check for duplicate/similar hypotheses (exact match)
            const existing = this.hypotheses.find(
                (h) =>
                    h.text === risk &&
                    (h.status === 'generated' || h.status === 'investigating')
            );
            if (existing) {
                hypothesisIds.push(existing.id);
                continue;
            }

            const hypothesis: TrackedHypothesis = {
                id: this.nextHypothesisId++,
                text: risk,
                generatedAtCheckpoint: checkpointNumber,
                status: 'generated',
                lastUpdatedAtCheckpoint: checkpointNumber,
                investigationTools: [],
            };
            this.hypotheses.push(hypothesis);
            hypothesisIds.push(hypothesis.id);
        }

        const checkpoint: ThinkCheckpoint = {
            number: checkpointNumber,
            topic,
            hypothesesGenerated: hypothesisIds,
            toolCallsSincePrevious: [...this.toolCallsSinceLastCheckpoint],
            investigationToolCount:
                this.getInvestigationToolCountSinceLastCheckpoint(),
        };

        this.checkpoints.push(checkpoint);
        this.toolCallsSinceLastCheckpoint = [];

        return checkpoint;
    }

    /** Mark hypotheses as investigating when investigation tools are called */
    markInvestigating(hypothesisIds: number[]): void {
        for (const id of hypothesisIds) {
            const h = this.hypotheses.find((h) => h.id === id);
            if (h && h.status === 'generated') {
                h.status = 'investigating';
                h.lastUpdatedAtCheckpoint = this.getCurrentCheckpointNumber();
            }
        }
    }

    /** Mark a hypothesis as confirmed (finding recorded) */
    markConfirmed(
        hypothesisId: number,
        note?: string,
        findingId?: string
    ): void {
        const h = this.hypotheses.find((h) => h.id === hypothesisId);
        if (h && (h.status === 'generated' || h.status === 'investigating')) {
            h.status = 'confirmed';
            h.lastUpdatedAtCheckpoint = this.getCurrentCheckpointNumber();
            h.resolutionNote = note;
            h.confirmedByFindingId = findingId;
        }
    }

    /** Mark a hypothesis as dismissed with reason */
    markDismissed(hypothesisId: number, note?: string): void {
        const h = this.hypotheses.find((h) => h.id === hypothesisId);
        if (h && (h.status === 'generated' || h.status === 'investigating')) {
            h.status = 'dismissed';
            h.lastUpdatedAtCheckpoint = this.getCurrentCheckpointNumber();
            h.resolutionNote = note;
        }
    }

    /** Revert a confirmed hypothesis back to investigating (e.g., when finding is retracted) */
    revertToInvestigating(hypothesisId: number, note?: string): void {
        const h = this.hypotheses.find((h) => h.id === hypothesisId);
        if (h && h.status === 'confirmed') {
            h.status = 'investigating';
            h.lastUpdatedAtCheckpoint = this.getCurrentCheckpointNumber();
            h.resolutionNote = note;
            h.confirmedByFindingId = undefined;
        }
    }

    /** Mark a hypothesis as abandoned (started but explicitly dropped) */
    markAbandoned(hypothesisId: number, note?: string): void {
        const h = this.hypotheses.find((h) => h.id === hypothesisId);
        if (h && (h.status === 'generated' || h.status === 'investigating')) {
            h.status = 'abandoned';
            h.lastUpdatedAtCheckpoint = this.getCurrentCheckpointNumber();
            h.resolutionNote = note;
        }
    }

    /** Get hypotheses that were generated but never investigated */
    getUninvestigatedHypotheses(): TrackedHypothesis[] {
        return this.hypotheses.filter(
            (h) => h.status === 'generated' && h.investigationTools.length === 0
        );
    }

    /** Get hypotheses that are still open (not confirmed or dismissed) */
    getOpenHypotheses(): TrackedHypothesis[] {
        return this.hypotheses.filter(
            (h) => h.status === 'generated' || h.status === 'investigating'
        );
    }

    /** Get all tracked hypotheses */
    getAllHypotheses(): readonly TrackedHypothesis[] {
        return this.hypotheses;
    }

    /** Get all checkpoints */
    getAllCheckpoints(): readonly ThinkCheckpoint[] {
        return this.checkpoints;
    }

    /** Get the current checkpoint count */
    getCheckpointCount(): number {
        return this.checkpoints.length;
    }

    /** Check if any investigation tools were called since last checkpoint */
    hasInvestigationSinceLastCheckpoint(): boolean {
        return this.getInvestigationToolCountSinceLastCheckpoint() > 0;
    }

    /** Generate a summary for the think_about_completion CoVe */
    generateHypothesisTrailSummary(): string {
        if (this.hypotheses.length === 0) {
            return 'No hypotheses were generated during analysis.';
        }

        const confirmed = this.hypotheses.filter(
            (h) => h.status === 'confirmed'
        );
        const dismissed = this.hypotheses.filter(
            (h) => h.status === 'dismissed'
        );
        const abandoned = this.hypotheses.filter(
            (h) => h.status === 'abandoned'
        );
        const uninvestigated = this.getUninvestigatedHypotheses();
        const investigating = this.hypotheses.filter(
            (h) => h.status === 'investigating'
        );

        const lines: string[] = [
            `Hypothesis Trail: ${this.hypotheses.length} total, ${confirmed.length} confirmed, ${dismissed.length} dismissed, ${abandoned.length} abandoned, ${uninvestigated.length} uninvestigated, ${investigating.length} still investigating`,
        ];

        if (uninvestigated.length > 0) {
            lines.push('');
            lines.push(
                '⚠️ UNINVESTIGATED HYPOTHESES (generated but never followed up):'
            );
            for (const h of uninvestigated) {
                lines.push(
                    `  - [H${h.id}] "${h.text}" (checkpoint ${h.generatedAtCheckpoint})`
                );
            }
            lines.push(
                'These hypotheses were generated but NO investigation tools were called for them. Investigate or explicitly dismiss each one.'
            );
        }

        if (investigating.length > 0) {
            lines.push('');
            lines.push('🔍 STILL INVESTIGATING (started but not resolved):');
            for (const h of investigating) {
                lines.push(
                    `  - [H${h.id}] "${h.text}" — tools used: ${h.investigationTools.join(', ') || 'none'}`
                );
            }
        }

        if (confirmed.length > 0) {
            lines.push('');
            lines.push('✅ CONFIRMED (recorded as findings):');
            for (const h of confirmed) {
                lines.push(
                    `  - [H${h.id}] "${h.text}"${h.resolutionNote ? ` — ${h.resolutionNote}` : ''}`
                );
            }
        }

        if (dismissed.length > 0) {
            lines.push('');
            lines.push('❌ DISMISSED (disproved with evidence):');
            for (const h of dismissed) {
                lines.push(
                    `  - [H${h.id}] "${h.text}"${h.resolutionNote ? ` — ${h.resolutionNote}` : ''}`
                );
            }
        }

        if (abandoned.length > 0) {
            lines.push('');
            lines.push('🚫 ABANDONED (dropped without resolution):');
            for (const h of abandoned) {
                lines.push(
                    `  - [H${h.id}] "${h.text}"${h.resolutionNote ? ` — ${h.resolutionNote}` : ''}`
                );
            }
        }

        return lines.join('\n');
    }
}
