import { TEXT_EXTENSIONS } from '../constants';

export class FileFilter {
  private ignoredPaths: string[];

  constructor(ignoredPaths: string[]) {
    this.ignoredPaths = ignoredPaths;
  }

  updateIgnoredPaths(paths: string[]): void {
    this.ignoredPaths = paths;
  }

  shouldIgnore(filePath: string): boolean {
    return this.ignoredPaths.some(pattern => {
      if (pattern.endsWith('/')) {
        return filePath.startsWith(pattern) || filePath.startsWith(pattern.slice(0, -1));
      }
      return filePath === pattern || filePath.startsWith(pattern + '/');
    });
  }

  isTextFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return TEXT_EXTENSIONS.has(ext);
  }
}
