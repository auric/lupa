import * as child_process from 'node:child_process';
import * as vscode from 'vscode';
import { Log } from '../../services/loggingService';
import { getErrorMessage } from '../../utils/errorUtils';

const GIT_POST_KILL_RETRY_MS = 2_000;
const GIT_POST_KILL_MAX_RETRIES = 5;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;

export function spawnGit(
    cwd: string,
    args: string[],
    timeoutMs: number,
    cancellationToken?: vscode.CancellationToken,
    acceptableExitCodes: readonly number[] = [0]
): Promise<string> {
    return new Promise((resolve, reject) => {
        if (cancellationToken?.isCancellationRequested) {
            reject(new vscode.CancellationError());
            return;
        }
        const proc = child_process.spawn('git', args, {
            cwd,
            detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
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

            if (process.platform !== 'win32' && proc.pid) {
                try {
                    process.kill(-proc.pid, 'SIGKILL');
                } catch {
                    // already gone
                }
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
        proc.stdout.on('error', () => {});
        proc.stderr.on('error', () => {});
        proc.stdout.setEncoding?.('utf8');
        proc.stderr.setEncoding?.('utf8');
        proc.stdout.on('data', (d) => {
            if (settled) {
                return;
            }
            outputBytes +=
                typeof d === 'string' ? Buffer.byteLength(d, 'utf8') : d.length;
            if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
                if (!settled) {
                    settled = true;
                    clearSettlingResources();
                    keepKillingUntilClose();
                    reject(
                        new Error(
                            `git ${args.join(' ')} output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes`
                        )
                    );
                }
                return;
            }
            stdout += d;
        });
        proc.stderr.on('data', (d) => {
            if (settled) {
                return;
            }
            outputBytes +=
                typeof d === 'string' ? Buffer.byteLength(d, 'utf8') : d.length;
            if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
                if (!settled) {
                    settled = true;
                    clearSettlingResources();
                    keepKillingUntilClose();
                    reject(
                        new Error(
                            `git ${args.join(' ')} output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes`
                        )
                    );
                }
                return;
            }
            stderr += d;
        });
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
            if (code !== null && acceptableExitCodes.includes(code)) {
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
