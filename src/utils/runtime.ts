type DynamicRequire = (moduleName: string) => unknown;

export function getDynamicRequire(): DynamicRequire | null {
  const globalRequire = (globalThis as { require?: DynamicRequire }).require;
  if (typeof globalRequire === 'function') {
    return globalRequire;
  }

  try {
    return Function('return typeof require === "function" ? require : null;')() as DynamicRequire | null;
  } catch {
    return null;
  }
}

export function canUseNodeRuntime(): boolean {
  return getDynamicRequire() !== null;
}

export function supportsIncomingConnections(): boolean {
  return canUseNodeRuntime();
}
