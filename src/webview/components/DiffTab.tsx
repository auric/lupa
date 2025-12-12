import React, { memo, useMemo } from 'react';
import { Diff, Hunk, tokenize, markEdits, parseDiff } from 'react-diff-view';
import 'react-diff-view/style/index.css';

interface DiffTabProps {
    diffText: string;
    viewType: 'split' | 'unified';
}

export const DiffTab = memo<DiffTabProps>(({ diffText, viewType }) => {
    console.time('Diff tab render');

    const diffFiles = useMemo(() => {
        if (!diffText) return [];

        console.time('Diff parsing');
        try {
            const files = parseDiff(diffText);
            console.timeEnd('Diff parsing');
            return files;
        } catch (error) {
            console.error('Error parsing diff:', error);
            console.timeEnd('Diff parsing');
            return [];
        }
    }, [diffText]);

    if (diffFiles.length === 0) {
        return <div className="text-center text-muted-foreground p-8">No changes to display</div>;
    }

    // Tokenize files for word-level diff highlighting
    const tokenizedFiles = useMemo(() => {
        return diffFiles.map(file => {
            try {
                // Use tokenize with markEdits enhancer for word-level highlighting
                const options = {
                    enhancers: [
                        markEdits(file.hunks, { type: 'line' })
                    ]
                };
                const tokens = tokenize(file.hunks, options);
                return { ...file, tokens };
            } catch (error) {
                console.warn('Failed to tokenize file:', file.newPath || file.oldPath, error);
                return { ...file, tokens: null };
            }
        });
    }, [diffFiles]);

    const result = (
        <div className="border rounded-lg bg-background flex-1 min-h-0 overflow-auto">
            <div className="w-full">
                {tokenizedFiles.map((file, index) => (
                    <div key={index} className="mb-4">
                        {/* File header */}
                        <div className="bg-muted p-2 text-sm font-mono border-b">
                            {file.oldPath && file.newPath && file.oldPath !== file.newPath ? (
                                <span>{file.oldPath} → {file.newPath}</span>
                            ) : (
                                <span>{file.newPath || file.oldPath}</span>
                            )}
                        </div>

                        {/* Diff content */}
                        <Diff
                            viewType={viewType}
                            diffType={file.type}
                            hunks={file.hunks}
                            className="text-sm"
                            tokens={file.tokens}
                        >
                            {hunks => hunks.map(hunk => (
                                <Hunk key={hunk.content} hunk={hunk} />
                            ))}
                        </Diff>
                    </div>
                ))}
            </div>
        </div>
    );

    console.timeEnd('Diff tab render');
    return result;
});