import { INVESTIGATION_TOOLS } from './toolConstants';
import type { RecursiveStateManager } from '../sessions/recursiveStateManager';
import type { DiffHunk } from '../types/contextTypes';
import type { SubagentSessionManager } from '../services/subagentSessionManager';
import { Log } from '../services/loggingService';

/**
 * Creates a callback that injects coverage gap messages after subagent rounds.
 * When subagents complete, reports which files haven't been examined yet,
 * prompting the root agent to spawn additional subagents for uncovered files.
 *
 * Shared between ToolCallingAnalysisProvider and ChatParticipantService.
 */
export function createCoverageGapCallback(
    recursiveState: RecursiveStateManager | undefined,
    parsedDiff: DiffHunk[],
    disabledToolNames: Set<string>,
    sessionManager: SubagentSessionManager
): ((toolNames: string[]) => string | undefined) | undefined {
    if (!recursiveState || parsedDiff.length === 0) {
        return undefined;
    }

    const allFiles = parsedDiff.map((d) => d.filePath);

    return (toolNames: string[]) => {
        if (!toolNames.includes('run_subagent')) {
            return undefined;
        }

        // If subagent budget is exhausted, re-enable investigation tools
        // so the root can directly examine uncovered files.
        if (!sessionManager.canSpawn()) {
            for (const tool of INVESTIGATION_TOOLS) {
                disabledToolNames.delete(tool);
            }
            return recursiveState.getCoverageGapFallbackMessage(allFiles);
        }

        // After first subagent round, disable investigation tools for the root.
        // The root is a controller — it delegates, not investigates.
        if (disabledToolNames.size === 0) {
            for (const tool of INVESTIGATION_TOOLS) {
                disabledToolNames.add(tool);
            }
            Log.info(
                'Root agent investigation tools disabled after first subagent round'
            );
        }

        return recursiveState.getCoverageGapMessage(allFiles);
    };
}
