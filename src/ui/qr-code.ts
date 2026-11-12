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
  // Parsed as SVG rather than set through innerHTML, which Obsidian's plugin
  // review does not allow.
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  if (parsed?.nodeName !== 'svg') return;
  const svgEl = container.appendChild(document.importNode(parsed, true)) as unknown as SVGElement;
  svgEl.setAttribute('width', '200');
  svgEl.setAttribute('height', '200');
  svgEl.style.display = 'block';
  svgEl.style.margin = '0 auto';
}
