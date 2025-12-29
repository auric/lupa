import { stringify } from 'html-safe-json';

export function safeJsonStringify(value: unknown): string {
    return stringify(value);
}
