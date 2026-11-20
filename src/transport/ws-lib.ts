/**
 * The ws library, loaded on first use. It needs Node.js, which only the
 * desktop app has, so it is not imported at the top of a module: that would
 * run its code on phones too, where it fails as the plugin loads.
 */
type WsModule = typeof import('ws');

let loaded: WsModule | null = null;
let loading: Promise<WsModule> | null = null;

export function loadWs(): Promise<WsModule> {
  loading ??= import('ws').then(
    (ws) => (loaded = ws),
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

/** The library if loadWs already finished, else null. */
export function loadedWs(): WsModule | null {
  return loaded;
}
