import { PLUGIN_ID } from '../constants';

/**
 * Build the obsidian:// URI that, when opened, adds a manual peer and (after
 * the user confirms) takes over this device's sync key.
 */
export function buildPeerURI(ip: string, port: number, syncKey?: string): string {
  const base = `obsidian://${PLUGIN_ID}?address=${ip}:${port}`;
  return syncKey ? `${base}&key=${encodeURIComponent(syncKey)}` : base;
}

/**
 * Render QR code SVG into the given container element.
 * Returns the generated URI string so the caller can display it.
 */
export async function renderQRCode(
  container: HTMLElement,
  text: string,
): Promise<void> {
  const QRCode = (await import('qrcode')).default;
  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 2,
    width: 200,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });

  container.empty();
  container.innerHTML = svg;

  // Ensure the SVG adapts to the container
  const svgEl = container.querySelector('svg');
  if (svgEl) {
    svgEl.setAttribute('width', '200');
    svgEl.setAttribute('height', '200');
    svgEl.style.display = 'block';
    svgEl.style.margin = '0 auto';
  }
}
