import React, { useState, useEffect, useCallback } from 'react';
import { ToolLibrarySidebar } from './components/ToolLibrarySidebar';
import { ParameterInputPanel } from './components/ParameterInputPanel';
import { ResultsPanel } from './components/ResultsPanel';
import { useVSCodeApi } from './hooks/useVSCodeApi';
import { useTheme } from './hooks/useTheme';
import { useToolExecution } from './hooks/useToolExecution';
import { useResponsiveLayout } from './hooks/useResponsiveLayout';
import type {
  ToolTestingViewProps,
  ToolInfo
} from './types/toolTestingTypes';

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
  const currentToolInfo = React.useMemo(() => {
    if (!selectedTool || !tools.length) return undefined;
    return tools.find(t => t.name === selectedTool);
  }, [selectedTool, tools]);

  // Event handlers
  const handleToolSelect = useCallback((toolName: string) => {
    setSelectedTool(toolName);
    clearSession(); // Clear previous results when selecting new tool
  }, [clearSession]);

  const handleExecute = useCallback(async (parameters: Record<string, any>) => {
    if (!selectedTool) return;
    
    try {
      await executeToolTest(selectedTool, parameters);
    } catch (error) {
      // Error handling is managed by useToolExecution hook
      console.error('Tool execution failed:', error);
    }
  }, [selectedTool, executeToolTest]);


  const handleNavigateToFile = useCallback((filePath: string, line?: number) => {
    vscode?.postMessage({
      command: 'openFile',
      payload: { filePath, line }
    });
  }, [vscode]);

  const handleTabChange = useCallback((tab: 'parameters' | 'results') => {
    setActiveTab(tab);
  }, []);

  // Auto-switch to results tab when execution starts
  useEffect(() => {
    if (isExecuting || currentSession) {
      setActiveTab('results');
    }
  }, [isExecuting, currentSession]);

  return (
    <div className={`toolTesting-interface ${isDarkTheme ? 'dark' : ''} layout-${layout.mode}`}>
      {/* Tool Selection Sidebar */}
      <div className="toolTesting-sidebar">
        <ToolLibrarySidebar
          tools={tools}
          selectedTool={selectedTool}
          searchQuery={searchQuery}
          onToolSelect={handleToolSelect}
          onSearchChange={setSearchQuery}
        />
      </div>

      {/* Main Workspace Area */}
      <div className="toolTesting-workspace">
        {layout.shouldStack ? (
          /* Stacked Layout for Narrow Screens */
          <div className="toolTesting-tabs">
            <div className="toolTesting-tabList">
              <button
                className={`toolTesting-tab ${activeTab === 'parameters' ? 'active' : ''}`}
                onClick={() => handleTabChange('parameters')}
                disabled={!selectedTool}
              >
                Parameters
              </button>
              <button
                className={`toolTesting-tab ${activeTab === 'results' ? 'active' : ''}`}
                onClick={() => handleTabChange('results')}
              >
                Results
              </button>
            </div>
            
            <div className="toolTesting-tabContent">
              {activeTab === 'parameters' ? (
                <ParameterInputPanel
                  toolInfo={currentToolInfo}
                  initialParameters={initialParameters}
                  onExecute={handleExecute}
                  isExecuting={isExecuting}
                  validationErrors={validationErrors}
                  onCancel={cancelExecution}
                />
              ) : (
                <ResultsPanel
                  session={currentSession}
                  isExecuting={isExecuting}
                  onNavigateToFile={handleNavigateToFile}
                />
              )}
            </div>
          </div>
        ) : (
          /* Side-by-Side Layout for Wide Screens */
          <>
            <div className="toolTesting-parameterPanel">
              <ParameterInputPanel
                toolInfo={currentToolInfo}
                initialParameters={initialParameters}
                onExecute={handleExecute}
                isExecuting={isExecuting}
                validationErrors={validationErrors}
                onCancel={cancelExecution}
              />
            </div>

            <div className="toolTesting-resultsPanel">
              <ResultsPanel
                session={currentSession}
                isExecuting={isExecuting}
                onNavigateToFile={handleNavigateToFile}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ToolTestingView;