import React from 'react';
import type { ToolInfo } from '../../types/toolTestingTypes';
import { Input } from '../../../components/ui/input';

interface ToolLibrarySidebarProps {
  tools: ToolInfo[];
  selectedTool: string | undefined;
  searchQuery: string;
  onToolSelect: (toolName: string) => void;
  onSearchChange: (query: string) => void;
}

// React Compiler handles memoization automatically
export const ToolLibrarySidebar: React.FC<ToolLibrarySidebarProps> = ({
  tools,
  selectedTool,
  searchQuery,
  onToolSelect,
  onSearchChange
}) => {

  // Filter tools based on search query
  const filteredTools = searchQuery
    ? tools.filter(tool =>
      tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tool.description.toLowerCase().includes(searchQuery.toLowerCase())
    )
    : tools;

  const handleToolSelect = (toolName: string) => {
    onToolSelect(toolName);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Select first tool in filtered results
      const firstTool = filteredTools[0];
      if (firstTool) {
        handleToolSelect(firstTool.name);
      }
    }
  };

  const handleClearSearch = () => {
    onSearchChange('');
  };

  return (
    <div className="flex flex-col h-full bg-transparent">
      {/* Search Header */}
      <div className="p-3 border-b border-border bg-transparent">
        <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2 px-1">Tools</h2>
        <div className="relative">
          <Input
            type="text"
            placeholder="Search tools..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="h-7 pr-8"
            aria-label="Search tools"
          />
          {searchQuery && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 rounded-sm transition-colors"
              onClick={handleClearSearch}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          {/* All Tools */}
          <div className="flex flex-col gap-0.5">
            {filteredTools.map(tool => (
              <ToolItem
                key={tool.name}
                tool={tool}
                isSelected={selectedTool === tool.name}
                onSelect={handleToolSelect}
              />
            ))}
          </div>

          {/* Empty State */}
          {filteredTools.length === 0 && searchQuery && (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <div className="text-2xl mb-2">🔍</div>
              <p className="mb-3">No tools found for "{searchQuery}"</p>
              <button
                className="text-xs bg-secondary text-secondary-foreground hover:bg-secondary/80 px-3 py-1 rounded-sm transition-colors"
                onClick={handleClearSearch}
              >
                Clear Search
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface ToolItemProps {
  tool: ToolInfo;
  isSelected: boolean;
  onSelect: (toolName: string) => void;
}

const ToolItem: React.FC<ToolItemProps> = ({
  tool,
  isSelected,
  onSelect
}) => {
  const handleClick = () => {
    onSelect(tool.name);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(tool.name);
    }
  };

  return (
    <div
      className={`
        flex items-start gap-2 p-1.5 cursor-pointer rounded-sm transition-colors outline-none
        ${isSelected
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/50 hover:text-accent-foreground'
        }
      `}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate mb-0.5">{tool.name}</div>
        <div className="text-xs text-muted-foreground truncate opacity-80">{tool.description}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {tool.isFavorite && <span className="text-xs">⭐</span>}
        {tool.usageCount > 0 && (
          <span className="text-[10px] bg-muted text-muted-foreground px-1 rounded-sm">{tool.usageCount}</span>
        )}
      </div>
    </div>
  );
};

export default ToolLibrarySidebar;