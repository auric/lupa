/**
 * Utility for detecting code files based on file extensions.
 * Focuses on files containing analyzable code symbols (functions, classes, methods, variables).
 *
 * NOTE: Explicitly excludes markup/config/data files (html, css, yaml, json, xml, md)
 * as these don't contain traditional code symbols.
 */
export class CodeFileDetector {
  private static readonly CODE_EXTENSIONS = new Set([
    // JavaScript/TypeScript
    'js', 'jsx', 'mjs', 'cjs',
    'ts', 'tsx', 'mts', 'cts',

    // C/C++
    'c', 'h',
    'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx',

    // Python
    'py', 'pyi', 'pyw', 'pyx',

    // JVM
    'java',
    'kt', 'kts',
    'scala',
    'groovy',
    'clj', 'cljs', 'cljc',

    // .NET
    'cs',
    'fs', 'fsx',
    'vb',

    // Systems
    'go',
    'rs',
    'zig',
    'nim',

    // Ruby
    'rb', 'rake',

    // PHP
    'php', 'phtml',

    // Apple
    'swift',
    'm', 'mm',

    // BEAM (Erlang VM)
    'ex', 'exs',
    'erl', 'hrl',

    // Functional
    'hs', 'lhs',
    'elm',
    'ml', 'mli',

    // Other
    'lua',
    'pl', 'pm',
    'r',
    'dart',
    'jl',
    'tcl',
    'cr',

    // Shell
    'sh', 'bash', 'zsh', 'fish', 'ksh',
    'ps1', 'psm1', 'psd1',
    'bat', 'cmd',

    // Web frameworks (contain script sections)
    'vue',
    'svelte',
    'astro',

    // CSS preprocessors (have variables, functions, mixins)
    'scss', 'sass', 'less', 'styl',

    // Templates with logic
    'erb', 'ejs', 'hbs',
    'pug', 'jade',
    'j2', 'jinja', 'jinja2',

    // Database
    'sql', 'plsql', 'pls',

    // Build DSLs
    'gradle',
    'bzl',
    'cmake',
  ]);

  private static readonly CODE_FILENAMES = new Set([
    'dockerfile',
    'containerfile',
    'makefile',
    'gnumakefile',
    'jenkinsfile',
    'rakefile',
    'gemfile',
    'vagrantfile',
    'podfile',
    'justfile',
    'taskfile',
  ]);

  static isCodeFile(filePath: string): boolean {
    if (!filePath) return false;

    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const fileName = (lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath).toLowerCase();

    if (this.CODE_FILENAMES.has(fileName)) return true;

    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex > 0) {
      const ext = fileName.slice(dotIndex + 1);
      return this.CODE_EXTENSIONS.has(ext);
    }

    return false;
  }

  static filterCodeFiles(filePaths: string[]): string[] {
    return filePaths.filter(fp => this.isCodeFile(fp));
  }

  static getSupportedExtensions(): readonly string[] {
    return [...this.CODE_EXTENSIONS];
  }

  static getSupportedFilenames(): readonly string[] {
    return [...this.CODE_FILENAMES];
  }

  static getGlobPattern(): string {
    const exts = [...this.CODE_EXTENSIONS].join(',');
    return `*.{${exts}}`;
  }
}