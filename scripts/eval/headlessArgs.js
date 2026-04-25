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
    'Usage: --workspace <path> --model <vendor/id> ' +
    '[--mode analysis --base <ref> --head <ref> --seed <n>] ' +
    '[--mode resolution-judge --payload <jsonPath>] ' +
    '[--timeout <ms>] [--deadline-at <unixMs>] [--out <jsonPath>] [--silent]';

/**
 * Parse argv tokens into a typed options object.
 *
 * @param {string[]} argv Raw argument tokens (excluding node/script).
 * @returns {{mode:'analysis'|'resolution-judge', workspace:string, model:string,
 *   base?:string, head?:string, seed?:number, payload?:string,
 *   timeoutMs:number, deadlineAt:number|null, out:string|null, silent:boolean}}
 */
function parseHeadlessArgs(argv) {
    const opts = {
        mode: 'analysis',
        workspace: null,
        base: null,
        head: null,
        model: null,
        seed: DEFAULT_SEED,
        payload: null,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        deadlineAt: null,
        out: null,
        silent: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        switch (token) {
            case '--mode':
                opts.mode = requireValue(argv, ++i, token);
                break;
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
            case '--payload':
                opts.payload = requireValue(argv, ++i, token);
                break;
            case '--timeout':
                opts.timeoutMs = parseIntFlag(
                    requireValue(argv, ++i, token),
                    token
                );
                break;
            case '--deadline-at':
                opts.deadlineAt = parseIntFlag(
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

    if (opts.mode !== 'analysis' && opts.mode !== 'resolution-judge') {
        throw new HeadlessArgError(
            `--mode must be 'analysis' or 'resolution-judge' (got ${opts.mode})\n${USAGE}`
        );
    }

    for (const required of ['workspace', 'model']) {
        if (!opts[required]) {
            throw new HeadlessArgError(
                `Missing required --${required}\n${USAGE}`
            );
        }
    }

    if (opts.mode === 'analysis') {
        for (const required of ['base', 'head']) {
            if (!opts[required]) {
                throw new HeadlessArgError(
                    `Missing required --${required}\n${USAGE}`
                );
            }
        }
    } else if (!opts.payload) {
        throw new HeadlessArgError(`Missing required --payload\n${USAGE}`);
    }

    if (opts.timeoutMs <= 0) {
        throw new HeadlessArgError(
            `--timeout must be a positive integer (got ${opts.timeoutMs})`
        );
    }

    if (opts.deadlineAt !== null && opts.deadlineAt <= 0) {
        throw new HeadlessArgError(
            `--deadline-at must be a positive integer (got ${opts.deadlineAt})`
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
    if (!Number.isFinite(n) || !/^[-+]?\d+$/.test(raw.trim())) {
        throw new HeadlessArgError(`${flag} must be an integer (got ${raw})`);
    }
    return n;
}

module.exports = { parseHeadlessArgs, HeadlessArgError, USAGE };
