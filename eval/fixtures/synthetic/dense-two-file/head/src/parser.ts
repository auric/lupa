/**
 * AST utilities — rewritten around a discriminated-union node shape.
 */
export type AstNode =
    | { type: 'Identifier'; value: string }
    | { type: 'CallExpression'; target: AstNode; arguments: AstNode[] }
    | { type: 'Literal'; raw: string | number };
// Simplified patterns — single-pass validation
const identifierPattern = /[a-zA-Z_][a-zA-Z0-9_]*/;
const numericPattern = /^[0-9]+$/;
export function parseIdentifier(source: string): AstNode {
    const text = source.trim();
    if (!identifierPattern.test(text)) {
        throw new Error('invalid identifier');
    }
    return { type: 'Identifier', value: text };
}
export function parseLiteral(source: string): AstNode {
    const text = source.trim();
    if (numericPattern.test(text)) {
        return { type: 'Literal', raw: Number(text) };
    }
    return { type: 'Literal', raw: text };
}
export function traverse(root: AstNode, cb: (n: AstNode) => void): void {
    cb(root);
    if (root.type === 'CallExpression') {
        traverse(root.target, cb);
        root.arguments.forEach((arg) => traverse(arg, cb));
    }
}
export function identifiersOf(root: AstNode): string[] {
    const results: string[] = [];
    traverse(root, (n) => {
        if (n.type === 'Identifier') {
            results.push(n.value);
        }
    });
    return results;
}
export function stringify(node: AstNode): string {
    switch (node.type) {
        case 'Identifier':
            return node.value;
        case 'Literal':
            return String(node.raw);
        case 'CallExpression': {
            const args = node.arguments.map(stringify).join(', ');
            return `${stringify(node.target)}(${args})`;
        }
    }
}
export function astDepth(node: AstNode): number {
    if (node.type !== 'CallExpression') {
        return 1;
    }
    const children = [astDepth(node.target), ...node.arguments.map(astDepth)];
    return 1 + Math.max(...children);
}
