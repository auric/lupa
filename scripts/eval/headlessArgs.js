/**
 * CLI arg parser for the headless launcher. Pulled into its own module so
 * it can be unit-tested without spawning an extension host.
 */

class HeadlessArgError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HeadlessArgError';
    }
}

const DEFAULT_SEED = 0;
const DEFAULT_TIMEOUT_MS = 600_000;
const USAGE =
    'Usage: --workspace <path> --base <ref> --head <ref> --model <vendor/id> ' +
    '[--seed <n>] [--timeout <ms>] [--out <jsonPath>] [--silent]';

/**
 * Parse argv tokens into a typed options object.
 *
 * @param {string[]} argv Raw argument tokens (excluding node/script).
 * @returns {{workspace:string, base:string, head:string, model:string,
 *   seed:number, timeoutMs:number, out:string|null, silent:boolean}}
 */
function parseHeadlessArgs(argv) {
    const opts = {
        workspace: null,
        base: null,
        head: null,
        model: null,
        seed: DEFAULT_SEED,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        out: null,
        silent: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        switch (token) {
            case '--workspace':
                opts.workspace = requireValue(argv, ++i, token);
                break;
            case '--base':
                opts.base = requireValue(argv, ++i, token);
                break;
            case '--head':
                opts.head = requireValue(argv, ++i, token);
                break;
            case '--model':
                opts.model = requireValue(argv, ++i, token);
                break;
            case '--seed':
                opts.seed = parseIntFlag(requireValue(argv, ++i, token), token);
                break;
            case '--timeout':
                opts.timeoutMs = parseIntFlag(
                    requireValue(argv, ++i, token),
                    token
                );
                break;
            case '--out':
                opts.out = requireValue(argv, ++i, token);
                break;
            case '--silent':
                opts.silent = true;
                break;
            default:
                throw new HeadlessArgError(
                    `Unknown argument: ${token}\n${USAGE}`
                );
        }
    }

    for (const required of ['workspace', 'base', 'head', 'model']) {
        if (!opts[required]) {
            throw new HeadlessArgError(
                `Missing required --${required}\n${USAGE}`
            );
        }
    }

    if (opts.timeoutMs <= 0) {
        throw new HeadlessArgError(
            `--timeout must be a positive integer (got ${opts.timeoutMs})`
        );
    }

    return opts;
}

function requireValue(argv, index, flag) {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) {
        throw new HeadlessArgError(`${flag} requires a value\n${USAGE}`);
    }
    return value;
}

function parseIntFlag(raw, flag) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || String(n) !== raw.trim()) {
        throw new HeadlessArgError(`${flag} must be an integer (got ${raw})`);
    }
    return n;
}

module.exports = { parseHeadlessArgs, HeadlessArgError, USAGE };
