import { describe, it, expect } from 'vitest';
import {
    parseIdentifier,
    collectIdentifiers,
    serialize,
    depth,
} from './parser';

describe('parser', () => {
    it('parses valid identifiers', () => {
        expect(parseIdentifier('foo')).toEqual({ kind: 'ident', name: 'foo' });
    });

    it('parses identifiers with underscores and digits', () => {
        expect(parseIdentifier('_foo2')).toEqual({
            kind: 'ident',
            name: '_foo2',
        });
    });

    it('rejects identifiers with special chars', () => {
        expect(() => parseIdentifier('foo; DROP TABLE users')).toThrow();
    });

    it('collects all identifiers from a call', () => {
        const node = {
            kind: 'call' as const,
            callee: { kind: 'ident' as const, name: 'add' },
            args: [
                { kind: 'ident' as const, name: 'x' },
                { kind: 'ident' as const, name: 'y' },
            ],
        };
        expect(collectIdentifiers(node)).toEqual(['add', 'x', 'y']);
    });

    it('serializes a call expression', () => {
        const node = {
            kind: 'call' as const,
            callee: { kind: 'ident' as const, name: 'f' },
            args: [{ kind: 'ident' as const, name: 'a' }],
        };
        expect(serialize(node)).toEqual('f(a)');
    });

    it('computes depth of leaf as one', () => {
        const node = { kind: 'ident' as const, name: 'x' };
        expect(depth(node)).toEqual(1);
    });
});
