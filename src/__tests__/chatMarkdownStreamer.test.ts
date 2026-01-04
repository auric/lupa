import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { streamMarkdownWithAnchors } from '../utils/chatMarkdownStreamer';

describe('streamMarkdownWithAnchors', () => {
    let mockStream: any;
    let workspaceRoot: vscode.Uri;

    beforeEach(() => {
        vi.clearAllMocks();

        // Mock stream methods
        mockStream = {
            markdown: vi.fn(),
            anchor: vi.fn(),
        };

        // Mock workspace root
        workspaceRoot = { fsPath: '/workspace' } as vscode.Uri;

        // Spy on Uri methods
        vi.spyOn(vscode.Uri, 'file').mockImplementation(
            (path: string) =>
                ({
                    fsPath: path,
                    toString: () => `file://${path}`,
                }) as any
        );

        vi.spyOn(vscode.Uri, 'joinPath').mockImplementation(
            (base: vscode.Uri, ...parts: string[]) =>
                ({
                    fsPath: `${base.fsPath}/${parts.join('/')}`,
                    toString: () => `file://${base.fsPath}/${parts.join('/')}`,
                }) as any
        );
    });

    it('should stream plain text without file links', () => {
        const markdown = 'This is plain text without any links.';

        streamMarkdownWithAnchors(mockStream, markdown, workspaceRoot);

        expect(mockStream.markdown).toHaveBeenCalledWith(
            'This is plain text without any links.'
        );
        expect(mockStream.anchor).not.toHaveBeenCalled();
    });

    it('should handle file paths without line numbers', () => {
        const markdown = 'Check out [src/file.ts](src/file.ts) for details.';

        streamMarkdownWithAnchors(mockStream, markdown, workspaceRoot);

        expect(mockStream.markdown).toHaveBeenCalledWith('Check out ');
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: '/workspace/src/file.ts' }),
            'src/file.ts'
        );
        expect(mockStream.markdown).toHaveBeenCalledWith(' for details.');
    });

    it('should handle file paths with single line numbers', () => {
        const markdown = 'See [src/file.ts:42](src/file.ts:42) for the issue.';

        streamMarkdownWithAnchors(mockStream, markdown, workspaceRoot);

        expect(mockStream.markdown).toHaveBeenCalledWith('See ');
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.any(Object), // Location object
            'src/file.ts:42'
        );
        expect(mockStream.markdown).toHaveBeenCalledWith(' for the issue.');

        // Verify Position/Range/Location were created with correct values
        expect(vscode.Position).toHaveBeenCalledWith(41, 0); // 42-1 = 41 (0-based start)
        expect(vscode.Position).toHaveBeenCalledWith(41, 0); // Same for single line
        expect(vscode.Range).toHaveBeenCalled();
        expect(vscode.Location).toHaveBeenCalled();
    });

    it('should handle file paths with line ranges', () => {
        const markdown =
            'The issue spans [src/file.ts:104-115](src/file.ts:104-115).';

        streamMarkdownWithAnchors(mockStream, markdown, workspaceRoot);

        expect(mockStream.markdown).toHaveBeenCalledWith('The issue spans ');
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.any(Object), // Location object
            'src/file.ts:104-115'
        );
        expect(mockStream.markdown).toHaveBeenCalledWith('.');

        // Verify line range is correctly converted to 0-based
        expect(vscode.Position).toHaveBeenCalledWith(103, 0); // 104-1 = 103
        expect(vscode.Position).toHaveBeenCalledWith(
            114,
            Number.MAX_SAFE_INTEGER
        ); // 115-1 = 114, end of line
        expect(vscode.Range).toHaveBeenCalled();
        expect(vscode.Location).toHaveBeenCalled();
    });

    it('should handle file paths with line and column', () => {
        const markdown = 'Look at [src/file.ts:10:5](src/file.ts:10:5).';

        streamMarkdownWithAnchors(mockStream, markdown, workspaceRoot);

        expect(mockStream.markdown).toHaveBeenCalledWith('Look at ');
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.any(Object), // Location object
            'src/file.ts:10:5'
        );
        expect(mockStream.markdown).toHaveBeenCalledWith('.');

        // Verify line:column creates zero-width selection at (line, column)
        // Both start and end should be at the same position (cursor positioning)
        expect(vscode.Position).toHaveBeenCalledWith(9, 4); // 10-1 = 9, 5-1 = 4
        expect(vscode.Position).toHaveBeenCalledWith(9, 4); // Same position for zero-width selection
        expect(vscode.Range).toHaveBeenCalled();
        expect(vscode.Location).toHaveBeenCalled();
    });

    it('should handle multiple file links in mixed content', () => {
        const markdown =
            'Check [file1.ts:10](file1.ts:10) and [file2.ts:20-25](file2.ts:20-25) for details.';

        streamMarkdownWithAnchors(mockStream, markdown, workspaceRoot);

        expect(mockStream.markdown).toHaveBeenCalledTimes(3);
        expect(mockStream.markdown).toHaveBeenCalledWith('Check ');
        expect(mockStream.markdown).toHaveBeenCalledWith(' and ');
        expect(mockStream.markdown).toHaveBeenCalledWith(' for details.');

        expect(mockStream.anchor).toHaveBeenCalledTimes(2);
        // First anchor: file1.ts:10
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.any(Object),
            'file1.ts:10'
        );
        // Second anchor: file2.ts:20-25
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.any(Object),
            'file2.ts:20-25'
        );
    });

    it('should preserve external links as text', () => {
        const markdown =
            'See [external link](https://example.com) and [file.ts:42](file.ts:42).';

        streamMarkdownWithAnchors(mockStream, markdown, workspaceRoot);

        // External links are streamed as markdown text (link preserved)
        expect(mockStream.markdown).toHaveBeenCalledWith('See ');
        expect(mockStream.markdown).toHaveBeenCalledWith(
            '[external link](https://example.com)'
        );
        expect(mockStream.markdown).toHaveBeenCalledWith(' and ');
        // File link becomes an anchor
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.any(Object),
            'file.ts:42'
        );
        expect(mockStream.markdown).toHaveBeenCalledWith('.');
    });

    it('should handle absolute file paths', () => {
        const markdown =
            'Check [/absolute/path/file.ts:15](/absolute/path/file.ts:15).';

        streamMarkdownWithAnchors(mockStream, markdown, workspaceRoot);

        expect(mockStream.markdown).toHaveBeenCalledWith('Check ');
        // anchor receives a Location object with uri.fsPath
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.objectContaining({
                uri: expect.objectContaining({
                    fsPath: '/absolute/path/file.ts',
                }),
            }),
            '/absolute/path/file.ts:15'
        );
        expect(mockStream.markdown).toHaveBeenCalledWith('.');
    });

    it('should handle empty string', () => {
        streamMarkdownWithAnchors(mockStream, '', workspaceRoot);

        expect(mockStream.markdown).not.toHaveBeenCalled();
        expect(mockStream.anchor).not.toHaveBeenCalled();
    });

    it('should emit plain text when workspace root is undefined for relative paths', () => {
        const markdown = 'Check [file.ts:10](file.ts:10).';

        streamMarkdownWithAnchors(mockStream, markdown, undefined);

        expect(mockStream.markdown).toHaveBeenCalledWith('Check ');
        // Relative path without workspace root: emit as plain text, not anchor
        expect(mockStream.markdown).toHaveBeenCalledWith('file.ts:10');
        expect(mockStream.markdown).toHaveBeenCalledWith('.');
        expect(mockStream.anchor).not.toHaveBeenCalled();
    });

    it('should still create anchors for absolute paths when workspace root is undefined', () => {
        const markdown =
            'Check [/absolute/path/file.ts:10](/absolute/path/file.ts:10).';

        streamMarkdownWithAnchors(mockStream, markdown, undefined);

        expect(mockStream.markdown).toHaveBeenCalledWith('Check ');
        // Absolute path resolves without workspace root
        expect(mockStream.anchor).toHaveBeenCalledWith(
            expect.objectContaining({
                uri: expect.objectContaining({
                    fsPath: '/absolute/path/file.ts',
                }),
            }),
            '/absolute/path/file.ts:10'
        );
        expect(mockStream.markdown).toHaveBeenCalledWith('.');
    });
});
