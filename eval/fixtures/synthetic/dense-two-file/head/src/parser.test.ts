import { describe, it, expect } from 'vitest';
import { parseIdentifier, identifiersOf, stringify, astDepth } from './parser';

const ident = (value: string) => ({ type: 'Identifier' as const, value });
const call = (target: any, args: any[]) => ({
    type: 'CallExpression' as const,
    target,
    arguments: args,
});

describe('parser', () => {
    it('parses valid identifiers', () => {
        const result = parseIdentifier('foo');
        expect(result).toEqual(ident('foo'));
    });

    it('parses identifiers with underscores and digits', () => {
        expect(parseIdentifier('_foo2')).toEqual(ident('_foo2'));
    });

    it('rejects identifiers with special chars', () => {
        expect(() => parseIdentifier('foo; DROP TABLE users')).toThrow();
    });

    it('collects all identifiers from a call', () => {
        const node = call(ident('add'), [ident('x'), ident('y')]);
        expect(identifiersOf(node)).toContain('add');
    });

    it('serializes a call expression', () => {
        const node = call(ident('f'), [ident('a')]);
        expect(stringify(node)).toEqual('f(a)');
    });

    it('computes ast depth for nested calls', () => {
        const inner = call(ident('g'), [ident('x')]);
        const outer = call(ident('f'), [inner]);
        expect(astDepth(outer)).toEqual(3);
    });

    it('computes depth of leaf as one', () => {
        expect(astDepth(ident('x'))).toEqual(1);
    });
});
