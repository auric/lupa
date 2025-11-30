import React, { useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { JsonViewer } from './JsonViewer';
import { LiveTimer } from './LiveTimer';
import { StatusIndicator } from './StatusIndicator';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import type { ToolTestSession } from '../../types/toolTestingTypes';
import type { ExecutionStatus } from './StatusIndicator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { ScrollArea } from '../../../components/ui/scroll-area';

interface ResultsPanelProps {
  session: ToolTestSession | null;
  isExecuting: boolean;
  onNavigateToFile?: (filePath: string, line?: number) => void;
}

export const ResultsPanel: React.FC<ResultsPanelProps> = ({
  session,
  isExecuting,
  onNavigateToFile
}) => {
  const copyToClipboard = useCopyToClipboard();
  const [activeTab, setActiveTab] = useState<'output' | 'raw'>('output');

  const formatExecutionTime = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getExecutionStatus = (): ExecutionStatus => {
    if (isExecuting) return 'running';
    if (!session) return 'idle';
    return session.status as ExecutionStatus;
  };

  // Show loading state
  if (isExecuting) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <StatusIndicator status="running" />
          <LiveTimer isRunning={true} className="font-mono" />
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground">
          <div className="animate-spin text-4xl mb-4">⟳</div>
          <p>Running tool...</p>
        </div>
      </div>
    );
  }

  // Show empty state when no session
  if (!session) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <StatusIndicator status="idle" />
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground text-center">
          <div className="text-4xl mb-4">📊</div>
          <h3 className="text-lg font-semibold mb-2">No Results Yet</h3>
          <p className="max-w-xs">
            Configure parameters and execute a tool to see results here
          </p>
        </div>
      </div>
    );
  }

  const executionStatus = getExecutionStatus();

  // Show results
  return (
    <div className="flex flex-col h-full">
      {/* Results Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
        <StatusIndicator status={executionStatus} />

        <div className="flex items-center gap-4 text-muted-foreground">
          {isExecuting ? (
            <LiveTimer
              isRunning={true}
              className="font-mono"
            />
          ) : session.executionTime ? (
            <span className="font-mono">
              Final: {formatExecutionTime(session.executionTime)}
            </span>
          ) : null}
          <span className="opacity-70">
            {session.timestamp.toLocaleTimeString()}
          </span>
        </div>
      </div>

      {/* Results Content */}
      <div className="flex-1 flex overflow-hidden flex-col min-h-0">
        {session.status === 'error' && session.error ? (
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4">
              <div className="bg-destructive/10 border border-destructive/20 rounded-md p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-destructive font-semibold">
                    <StatusIndicator status="error" showText={false} />
                    <span>Execution Error</span>
                  </div>
                  <CopyButton
                    text={session.error}
                    onCopy={copyToClipboard}
                    className="h-6 w-6 p-0"
                  />
                </div>
                <pre className="font-mono whitespace-pre-wrap text-destructive-foreground">
                  <code>{session.error}</code>
                </pre>
              </div>
            </div>
          </ScrollArea>
        ) : session.results && session.results.length > 0 ? (
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="flex-1 flex flex-col">
            <div className="border-b border-border bg-muted/20">
              <TabsList className="h-9 bg-transparent p-0 w-full justify-start">
                <TabsTrigger
                  value="output"
                  className="h-9 rounded-none border-t border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-background data-[state=active]:shadow-none relative top-[1px]"
                >
                  Output
                </TabsTrigger>
                <TabsTrigger
                  value="raw"
                  className="h-9 rounded-none border-t border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-background data-[state=active]:shadow-none relative top-[1px]"
                >
                  Raw JSON
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex-1 overflow-hidden min-h-0 relative">
              <TabsContent value="output" className="absolute inset-0 m-0 p-0 border-none data-[state=inactive]:hidden">
                <ScrollArea className="h-full">
                  <div className="p-4 space-y-4">
                    {session.results.map((result, index) => (
                      <div key={result.id || index} className="relative group">
                        <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                          <CopyButton
                            text={JSON.stringify(result.data, null, 2)}
                            onCopy={copyToClipboard}
                            className="h-8 w-8 p-0 bg-background/80 backdrop-blur-sm border border-border shadow-sm"
                          />
                        </div>
                        <JsonViewer
                          data={result.data}
                          rootKey={`Result ${index + 1}`}
                          collapseDepth={index === 0 ? 2 : 1}
                        />
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </TabsContent>
              <TabsContent value="raw" className="absolute inset-0 m-0 p-0 border-none data-[state=inactive]:hidden">
                <ScrollArea className="h-full">
                  <div className="p-4 relative group">
                    <div className="absolute right-4 top-4 opacity-0 group-hover:opacity-100 transition-opacity">
                      <CopyButton
                        text={JSON.stringify(session.results.map(r => r.data), null, 2)}
                        onCopy={copyToClipboard}
                        className="h-8 px-2 bg-background/80 backdrop-blur-sm"
                      />
                    </div>
                    <pre className="text-xs font-mono whitespace-pre-wrap">
                      <code>
                        {JSON.stringify(session.results.map(r => r.data), null, 2)}
                      </code>
                    </pre>
                  </div>
                </ScrollArea>
              </TabsContent>
            </div>
          </Tabs>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground text-center">
            <div className="text-4xl mb-4">📭</div>
            <h3 className="text-lg font-semibold mb-2">No Output</h3>
            <p className="max-w-xs">
              The tool executed successfully but returned no results
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(ResultsPanel);