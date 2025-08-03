import React, { useMemo, useCallback } from 'react';
import type { ToolInfo } from '../types/toolTestingTypes';

interface ToolLibrarySidebarProps {
  tools: ToolInfo[];
  selectedTool: string | undefined;
  searchQuery: string;
  onToolSelect: (toolName: string) => void;
  onSearchChange: (query: string) => void;
}

export const ToolLibrarySidebar: React.FC<ToolLibrarySidebarProps> = ({
  tools,
  selectedTool,
  searchQuery,
  onToolSelect,
  onSearchChange
}) => {

  // Filter tools based on search query
  const filteredTools = useMemo(() => {
    if (!searchQuery) return tools;

    return tools.filter(tool =>
      tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tool.description.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [tools, searchQuery]);

  const handleToolSelect = useCallback((toolName: string) => {
    onToolSelect(toolName);
  }, [onToolSelect]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Select first tool in filtered results
      const firstTool = filteredTools[0];
      if (firstTool) {
        handleToolSelect(firstTool.name);
      }
    }
  }, [filteredTools, handleToolSelect]);

  const handleClearSearch = useCallback(() => {
    onSearchChange('');
  }, [onSearchChange]);

  return (
    <div className="tool-library-sidebar">
      {/* Search Header */}
      <div className="sidebar-header">
        <h2 className="sidebar-title">Tools</h2>
        <div className="search-container">
          <input
            type="text"
            placeholder="Search tools..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="tool-search"
            aria-label="Search tools"
          />
          {searchQuery && (
            <button
              className="search-clear-btn"
              onClick={handleClearSearch}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-content">
        {/* All Tools */}
        <div className="all-tools-section">
          <div className="tools-list">
            {filteredTools.map(tool => (
              <ToolItem
                key={tool.name}
                tool={tool}
                isSelected={selectedTool === tool.name}
                onSelect={handleToolSelect}
              />
            ))}
          </div>
        </div>

        {/* Empty State */}
        {filteredTools.length === 0 && searchQuery && (
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <p className="empty-state-text">No tools found for "{searchQuery}"</p>
            <button
              className="clear-search-btn"
              onClick={handleClearSearch}
            >
              Clear Search
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

interface ToolItemProps {
  tool: ToolInfo;
  isSelected: boolean;
  onSelect: (toolName: string) => void;
}

const ToolItem: React.FC<ToolItemProps> = React.memo(({
  tool,
  isSelected,
  onSelect
}) => {
  const handleClick = useCallback(() => {
    onSelect(tool.name);
  }, [tool.name, onSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(tool.name);
    }
  }, [tool.name, onSelect]);

  return (
    <div
      className={`tool-item ${isSelected ? 'selected' : ''}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
    >
      <div className="tool-info">
        <div className="tool-name">{tool.name}</div>
        <div className="tool-description">{tool.description}</div>
      </div>
      <div className="tool-meta">
        {tool.isFavorite && <span className="favorite-icon">⭐</span>}
        {tool.usageCount > 0 && (
          <span className="usage-count">{tool.usageCount}</span>
        )}
      </div>
    </div>
  );
});

export default React.memo(ToolLibrarySidebar);