import * as child_process from 'node:child_process';
import * as vscode from 'vscode';
import { Log } from '../../services/loggingService';
import { getErrorMessage } from '../../utils/errorUtils';

const GIT_POST_KILL_RETRY_MS = 2_000;
const GIT_POST_KILL_MAX_RETRIES = 5;

export function spawnGit(
    cwd: string,
    args: string[],
    timeoutMs: number,
    cancellationToken?: vscode.CancellationToken
): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = child_process.spawn('git', args, { cwd });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let closed = false;
        let cancellation: vscode.Disposable | undefined;
        let postKillHandle: NodeJS.Timeout | undefined;
        let killRetryCount = 0;
        const clearSettlingResources = () => {
            clearTimeout(timeoutHandle);
            cancellation?.dispose();
            cancellation = undefined;
        };
        const cleanupAfterClose = () => {
            closed = true;
            clearSettlingResources();
            if (postKillHandle) {
                clearTimeout(postKillHandle);
                postKillHandle = undefined;
            }
        };
        const keepKillingUntilClose = () => {
            if (closed) {
                return;
            }

            try {
                proc.kill('SIGKILL');
            } catch {
                // already gone
            }

            if (postKillHandle) {
                return;
            }

            if (killRetryCount >= GIT_POST_KILL_MAX_RETRIES) {
                Log.warn(
                    `git process could not be killed after ${GIT_POST_KILL_MAX_RETRIES} retries (${GIT_POST_KILL_MAX_RETRIES * GIT_POST_KILL_RETRY_MS}ms)`
                );
                return;
            }

            killRetryCount++;
            postKillHandle = setTimeout(() => {
                postKillHandle = undefined;
                keepKillingUntilClose();
            }, GIT_POST_KILL_RETRY_MS);
            postKillHandle.unref?.();
        };
        const timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            clearSettlingResources();
            keepKillingUntilClose();
            reject(
                new Error(
                    `git ${args.join(' ')} timed out after ${timeoutMs}ms`
                )
            );
        }, timeoutMs);

        cancellation = cancellationToken?.onCancellationRequested(() => {
            if (settled) {
                return;
            }
            settled = true;
            clearSettlingResources();
            keepKillingUntilClose();
            reject(new vscode.CancellationError());
        });
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('error', (error) => {
            cleanupAfterClose();
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        });
        proc.on('close', (code) => {
            cleanupAfterClose();
            if (settled) {
                return;
            }
            settled = true;
            if (code === 0 || code === 1) {
                resolve(stdout);
            } else {
                reject(
                    new Error(
                        `git ${args.join(' ')} failed (${code}): ${stderr || getErrorMessage(stdout)}`
                    )
                );
            }
        });
    });
}
