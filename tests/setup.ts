import { setConfigDir } from '../src/constants';

// The plugin reaches timers, require() and the like through `window`, as
// Obsidian's renderer has it. In Node the global object stands in for it.
(globalThis as any).window ??= globalThis;

// Where Obsidian keeps its config unless the user renamed the folder.
setConfigDir('.obsidian');
