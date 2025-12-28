import React, { useState, useEffect } from 'react';
import { ToolLibrarySidebar } from './components/ToolLibrarySidebar';
import { ParameterInputPanel } from './components/ParameterInputPanel';
import { ResultsPanel } from './components/ResultsPanel';
import { useVSCodeApi } from '../hooks/useVSCodeApi';
import { useTheme } from '../hooks/useTheme';
import { useToolExecution } from '../hooks/useToolExecution';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import type {
  ToolTestingViewProps,
  ToolInfo
} from '../types/toolTestingTypes';
import './styles/toolTesting.css';

const ToolTestingView: React.FC<ToolTestingViewProps> = ({
  initialTool,
  initialParameters = {}
}) => {
  const vscode = useVSCodeApi();
  const isDarkTheme = useTheme();
  const layout = useResponsiveLayout();

  // State management
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [selectedTool, setSelectedTool] = useState<string | undefined>(initialTool);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'parameters' | 'results'>('parameters');

  // Custom hooks
  const {
    currentSession,
    isExecuting,
    validationErrors,
    executeToolTest,
    cancelExecution,
    clearSession
  } = useToolExecution();

  // Initialize tools and handle initial tool selection
  useEffect(() => {
    // Request tools from extension
    vscode?.postMessage({
      command: 'getTools',
      payload: {}
    });

    // Set up message listeners
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case 'tools':
          setTools(message.payload.tools);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [vscode]);

  // Get current tool info
  // React Compiler handles memoization automatically
  const currentToolInfo = (() => {
    if (!selectedTool || !tools.length) { return undefined; }
    return tools.find(t => t.name === selectedTool);
  })();

  // Event handlers
  const handleToolSelect = (toolName: string) => {
    setSelectedTool(toolName);
    clearSession(); // Clear previous results when selecting new tool
  };

  const handleExecute = async (parameters: Record<string, any>) => {
    if (!selectedTool) { return; }

    try {
      await executeToolTest(selectedTool, parameters);
    } catch (error) {
      // Error handling is managed by useToolExecution hook
      console.error('Tool execution failed:', error);
    }
  };

  // Auto-switch to results tab when execution starts
  useEffect(() => {
    if (isExecuting || currentSession) {
      setActiveTab('results');
    }
  }, [isExecuting, currentSession]);

  return (
    <div className={`flex h-screen w-full bg-background text-foreground ${isDarkTheme ? 'dark' : ''}`}>
      {/* Tool Selection Sidebar */}
      <div className="w-64 border-r border-border bg-[var(--vscode-sideBar-background)] flex flex-col shrink-0">
        <ToolLibrarySidebar
          tools={tools}
          selectedTool={selectedTool}
          searchQuery={searchQuery}
          onToolSelect={handleToolSelect}
          onSearchChange={setSearchQuery}
        />
      </div>

      {/* Main Workspace Area */}
      <div className="flex-1 flex overflow-hidden flex-col">
        {layout.shouldStack ? (
          /* Stacked Layout for Narrow Screens */
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="flex-1 flex flex-col">
            <div className="border-b border-border bg-muted/10 px-4">
              <TabsList className="h-10 bg-transparent p-0">
                <TabsTrigger
                  value="parameters"
                  disabled={!selectedTool}
                  className="h-10 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
                >
                  Parameters
                </TabsTrigger>
                <TabsTrigger
                  value="results"
                  className="h-10 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
                >
                  Results
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex-1 overflow-hidden relative">
              <TabsContent value="parameters" className="absolute inset-0 m-0 p-0 border-none data-[state=inactive]:hidden">
                <ParameterInputPanel
                  toolInfo={currentToolInfo}
                  initialParameters={initialParameters}
                  onExecute={handleExecute}
                  isExecuting={isExecuting}
                  validationErrors={validationErrors}
                  onCancel={cancelExecution}
                />
              </TabsContent>
              <TabsContent value="results" className="absolute inset-0 m-0 p-0 border-none data-[state=inactive]:hidden">
                <ResultsPanel
                  session={currentSession}
                  isExecuting={isExecuting}
                />
              </TabsContent>
            </div>
          </Tabs>
        ) : (
          /* Side-by-Side Layout for Wide Screens */
          <div className="flex h-full">
            <div className="flex-1 border-r border-border min-w-[300px]">
              <ParameterInputPanel
                toolInfo={currentToolInfo}
                initialParameters={initialParameters}
                onExecute={handleExecute}
                isExecuting={isExecuting}
                validationErrors={validationErrors}
                onCancel={cancelExecution}
              />
            </div>

            <div className="flex-1 min-w-[300px]">
              <ResultsPanel
                session={currentSession}
                isExecuting={isExecuting}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ToolTestingView;
