/**
 * Minimal, import-free module exposing the headless-mode env-var contract.
 *
 * Kept separate from headlessEntry.ts so callers that only need to branch on
 * headless mode (e.g. ServiceManager during activation) do not transitively
 * pull in the full headless runtime (runHeadless, diffResolver, gitService).
 *
 * This module MUST NOT import from any other project module.
 */
export const LUPA_HEADLESS_MODE_ENV = 'LUPA_HEADLESS_MODE';
export const LUPA_HEADLESS_ARGS_ENV = 'LUPA_HEADLESS_ARGS';
export const LUPA_HEADLESS_SENTINEL_ENV = 'LUPA_HEADLESS_SENTINEL';

export function isHeadlessMode(): boolean {
    return process.env[LUPA_HEADLESS_MODE_ENV] === '1';
}
