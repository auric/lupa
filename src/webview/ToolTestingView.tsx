import React, { useState, useEffect, useCallback } from 'react';
import { ToolLibrarySidebar } from './components/ToolLibrarySidebar';
import { ParameterInputPanel } from './components/ParameterInputPanel';
import { ResultsPanel } from './components/ResultsPanel';
import { useVSCodeApi } from './hooks/useVSCodeApi';
import { useTheme } from './hooks/useTheme';
import { useToolExecution } from './hooks/useToolExecution';
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
  
  // State management
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [selectedTool, setSelectedTool] = useState<string | undefined>(initialTool);
  const [searchQuery, setSearchQuery] = useState('');
  
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

  return (
    <div className={`tool-testing-interface ${isDarkTheme ? 'dark' : ''}`}>
      {/* Left Panel - Tool Selection */}
      <div className="tool-sidebar">
        <ToolLibrarySidebar
          tools={tools}
          selectedTool={selectedTool}
          searchQuery={searchQuery}
          onToolSelect={handleToolSelect}
          onSearchChange={setSearchQuery}
        />
      </div>

      {/* Center Panel - Parameter Input */}
      <div className="tool-parameter-panel">
        <ParameterInputPanel
          toolInfo={currentToolInfo}
          initialParameters={initialParameters}
          onExecute={handleExecute}
          isExecuting={isExecuting}
          validationErrors={validationErrors}
          onCancel={cancelExecution}
        />
      </div>

      {/* Right Panel - Results */}
      <div className="tool-results-panel">
        <ResultsPanel
          session={currentSession}
          isExecuting={isExecuting}
          onNavigateToFile={handleNavigateToFile}
        />
      </div>
    </div>
  );
};

export default ToolTestingView;