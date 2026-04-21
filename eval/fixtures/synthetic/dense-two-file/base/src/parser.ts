export type Node =
    | { kind: 'ident'; name: string }
    | { kind: 'call'; callee: Node; args: Node[] }
    | { kind: 'literal'; value: string | number };

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const NUMBER_RE = /^[0-9]+$/;

export function parseIdentifier(raw: string): Node {
    const trimmed = raw.trim();
    if (!IDENT_RE.test(trimmed)) {
        throw new Error(`invalid identifier: ${raw}`);
    }
    return { kind: 'ident', name: trimmed };
}

export function parseLiteral(raw: string): Node {
    const trimmed = raw.trim();
    if (NUMBER_RE.test(trimmed)) {
        return { kind: 'literal', value: Number(trimmed) };
    }
    return { kind: 'literal', value: trimmed };
}

export function walk(node: Node, visit: (n: Node) => void): void {
    visit(node);
    if (node.kind === 'call') {
        walk(node.callee, visit);
        for (const a of node.args) {
            walk(a, visit);
        }
    }
}

export function collectIdentifiers(node: Node): string[] {
    const out: string[] = [];
    walk(node, (n) => {
        if (n.kind === 'ident') {
            out.push(n.name);
        }
    });
    return out;
}

export function serialize(node: Node): string {
    if (node.kind === 'ident') {
        return node.name;
    }
    if (node.kind === 'literal') {
        return String(node.value);
    }
    const args = node.args.map(serialize).join(', ');
    return `${serialize(node.callee)}(${args})`;
}

export function depth(node: Node): number {
    if (node.kind !== 'call') {
        return 1;
    }
    const childDepths = [depth(node.callee), ...node.args.map(depth)];
    return 1 + Math.max(...childDepths);
}
