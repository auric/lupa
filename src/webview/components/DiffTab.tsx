import React, { memo } from 'react';
import { Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';

interface DiffTabProps {
    diffFiles: any[];
    viewType: 'split' | 'unified';
}

export const DiffTab = memo<DiffTabProps>(({ diffFiles, viewType }) => {
    console.time('Diff tab render');

    if (diffFiles.length === 0) {
        return <div className="text-center text-muted-foreground p-8">No changes to display</div>;
    }

    const result = (
        <div className="border rounded-lg" style={{ maxHeight: '80vh', overflow: 'auto' }}>
            <div className="w-full">
                {diffFiles.map((file, index) => (
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