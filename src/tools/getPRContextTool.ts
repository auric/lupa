import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import type { GitOperationsManager } from '../services/gitOperationsManager';
import { Log } from '../services/loggingService';
import { getErrorMessage } from '../utils/errorUtils';

export class GetPRContextTool extends BaseTool {
    name = 'get_pr_context';
    description =
        'Get PR context: branch name and commit messages. ' +
        'Call this early in your review to understand the intent behind the changes ' +
        'before investigating individual files.';

    schema = z.object({});

    constructor(private gitOperationsManager: GitOperationsManager) {
        super();
    }

    async execute(
        _args: z.infer<typeof this.schema>,
        _context: ExecutionContext
    ): Promise<ToolResult> {
        const repo = this.gitOperationsManager.getRepository();
        if (!repo) {
            return toolError('Git repository not available');
        }

        const currentBranch = repo.state.HEAD?.name ?? 'detached HEAD';

        let result = `## PR Context\n\n`;
        result += `**Branch**: \`${currentBranch}\`\n`;

        // Get commit messages
        try {
            const defaultBranch =
                await this.gitOperationsManager.getDefaultBranch();
            if (defaultBranch) {
                result += `**Base**: \`${defaultBranch}\`\n\n`;
                const commits = await this.gitOperationsManager.getCommitLog(
                    defaultBranch,
                    30
                );
                if (commits.trim()) {
                    result += `### Commit Messages\n\`\`\`\n${commits}\n\`\`\`\n\n`;
                } else {
                    result += `_No commits found between ${defaultBranch} and ${currentBranch}_\n\n`;
                }
            } else {
                result += `_Could not determine base branch_\n\n`;
            }
        } catch (error) {
            Log.warn(
                `get_pr_context: failed to get commit log: ${getErrorMessage(error)}`
            );
            result += `_Could not retrieve commit messages_\n\n`;
        }

        return toolSuccess(result);
    }
}
