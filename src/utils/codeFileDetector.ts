import * as path from 'path';

/**
 * Utility for detecting code files based on file extensions and patterns.
 * Used to filter files when only_code_files parameter is enabled.
 * Focuses on files that contain analyzable code symbols (functions, classes, methods, variables).
 */
export class CodeFileDetector {
  /**
   * Programming language file extensions that contain analyzable code symbols
   */
  private static readonly CODE_EXTENSIONS = new Set([
    // JavaScript/TypeScript ecosystem
    'js', 'jsx', 'mjs', 'cjs',           // JavaScript variants
    'ts', 'tsx',                         // TypeScript
    
    // C/C++ family
    'c', 'h',                           // C
    'cpp', 'cxx', 'cc', 'c++',         // C++ source
    'hpp', 'hxx', 'h++', 'hh',         // C++ headers
    
    // Python ecosystem
    'py', 'pyx', 'pyi', 'pyw',         // Python, Cython, type stubs, Windows
    
    // JVM languages
    'java',                             // Java
    'kt', 'kts',                        // Kotlin
    'scala',                            // Scala
    'groovy',                           // Groovy
    'clj', 'cljs',                      // Clojure
    
    // .NET family
    'cs',                               // C#
    'fs',                               // F#
    'vb',                               // VB.NET
    
    // Systems programming
    'rs',                               // Rust
    'go',                               // Go
    'zig',                              // Zig
    'nim',                              // Nim
    'd',                                // D language
    'v',                                // V language
    
    // Dynamic languages
    'rb',                               // Ruby
    'php',                              // PHP
    'swift',                            // Swift
    'lua',                              // Lua
    'pl', 'pm',                         // Perl
    'tcl',                              // Tcl
    'r',                                // R language
    
    // Mobile development
    'dart',                             // Dart/Flutter
    'm', 'mm',                          // Objective-C/C++
    
    // Functional languages
    'hs',                               // Haskell
    'elm',                              // Elm
    'ml', 'mli',                        // OCaml
    
    // Shell/System scripts
    'sh', 'bash', 'zsh', 'fish',       // Unix shells
    'ps1',                              // PowerShell
    'bat', 'cmd',                       // Windows batch
    
    // Stylesheet languages (contain programming constructs)
    'scss', 'sass', 'less',             // CSS preprocessors with variables/functions
    
    // Database programming
    'sql', 'plsql', 'pls',              // SQL and PL/SQL
    
    // Template languages (contain code logic)
    'erb', 'ejs', 'hbs', 'mustache',   // Template engines
    'j2', 'jinja', 'jinja2'            // Jinja templates
  ]);

  /**
   * File names that are considered code files despite having no extension
   * Only includes files that definitely contain executable code or scripts
   */
  private static readonly CODE_FILENAMES = new Set([
    'dockerfile',
    'makefile', 
    'jenkinsfile',
    'rakefile',
    'gemfile',
    'vagrantfile'
  ]);

  /**
   * Check if a single file path represents a code file
   */
  static isCodeFile(filePath: string): boolean {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    const fileName = path.basename(filePath).toLowerCase();
    const extension = path.extname(filePath).slice(1).toLowerCase(); // Remove the dot

    // Check by filename (case insensitive) - only no-extension code files
    if (this.CODE_FILENAMES.has(fileName)) {
      return true;
    }

    // Check by extension
    if (extension && this.CODE_EXTENSIONS.has(extension)) {
      return true;
    }

    return false;
  }

  /**
   * Filter an array of file paths to include only code files
   */
  static filterCodeFiles(filePaths: string[]): string[] {
    return filePaths.filter(filePath => this.isCodeFile(filePath));
  }

  /**
   * Filter an array of file paths to exclude code files (opposite of filterCodeFiles)
   */
  static filterNonCodeFiles(filePaths: string[]): string[] {
    return filePaths.filter(filePath => !this.isCodeFile(filePath));
  }

  /**
   * Get statistics about code vs non-code files in the provided array
   */
  static getFileStats(filePaths: string[]): {
    total: number;
    codeFiles: number;
    nonCodeFiles: number;
    codeFilePercentage: number;
  } {
    const total = filePaths.length;
    const codeFiles = this.filterCodeFiles(filePaths).length;
    const nonCodeFiles = total - codeFiles;
    const codeFilePercentage = total > 0 ? Math.round((codeFiles / total) * 100) : 0;

    return {
      total,
      codeFiles,
      nonCodeFiles,
      codeFilePercentage
    };
  }

  /**
   * Check if a file extension is recognized as a code file extension
   */
  static isCodeExtension(extension: string): boolean {
    const cleanExtension = extension.startsWith('.') ? extension.slice(1) : extension;
    return this.CODE_EXTENSIONS.has(cleanExtension.toLowerCase());
  }

  /**
   * Get all supported code file extensions (for reference or debugging)
   */
  static getSupportedExtensions(): string[] {
    return Array.from(this.CODE_EXTENSIONS).sort();
  }

  /**
   * Get all recognized code filenames (for reference or debugging)  
   */
  static getSupportedFilenames(): string[] {
    return Array.from(this.CODE_FILENAMES).sort();
  }
}