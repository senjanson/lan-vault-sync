import { App, PluginSettingTab, Setting } from 'obsidian';
import type LANSyncPlugin from '../main';

export class LANSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LANSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'LAN Sync Settings' });

    new Setting(containerEl)
      .setName('Enable Sync')
      .setDesc('Turn LAN synchronization on or off.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          if (value) {
            await this.plugin.startSync();
          } else {
            await this.plugin.stopSync();
          }
        }));

    new Setting(containerEl)
      .setName('Device Name')
      .setDesc('A friendly name for this device.')
      .addText(text => text
        .setPlaceholder('e.g. MacBook Pro')
        .setValue(this.plugin.settings.deviceName)
        .onChange(async (value) => {
          this.plugin.settings.deviceName = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Port')
      .setDesc('WebSocket port for sync (change requires restart).')
      .addText(text => text
        .setPlaceholder('53712')
        .setValue(String(this.plugin.settings.port))
        .onChange(async (value) => {
          const port = parseInt(value, 10);
          if (!isNaN(port) && port > 1024 && port < 65536) {
            this.plugin.settings.port = port;
            await this.plugin.saveSettings();
          }
        }));

    // ─── Manual Peers ───────────────────────────────────
    containerEl.createEl('h3', { text: 'Manual Peers' });
    containerEl.createEl('p', {
      text: 'Add peers manually if auto-discovery doesn\'t work. Format: ip:port',
      cls: 'setting-item-description',
    });

    const peerContainer = containerEl.createDiv();
    this._renderPeerList(peerContainer);

    new Setting(containerEl)
      .setName('Add Peer')
      .addText(text => {
        text.setPlaceholder('192.168.1.100:53712');
        text.inputEl.addEventListener('keydown', async (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            const val = text.getValue().trim();
            if (val && val.includes(':')) {
              this.plugin.settings.manualPeers.push(val);
              await this.plugin.saveSettings();
              text.setValue('');
              this._renderPeerList(peerContainer);
            }
          }
        });
      })
      .addButton(btn => btn
        .setButtonText('Add')
        .onClick(async () => {
          const input = containerEl.querySelector('.setting-item:last-child input') as HTMLInputElement;
          if (input) {
            const val = input.value.trim();
            if (val && val.includes(':')) {
              this.plugin.settings.manualPeers.push(val);
              await this.plugin.saveSettings();
              input.value = '';
              this._renderPeerList(peerContainer);
            }
          }
        }));

    // ─── Ignored Paths ──────────────────────────────────
    containerEl.createEl('h3', { text: 'Ignored Paths' });

    new Setting(containerEl)
      .setName('Ignored Paths')
      .setDesc('Paths to exclude from sync (one per line). Paths ending with / match directories.')
      .addTextArea(text => text
        .setPlaceholder('.obsidian/\n.trash/')
        .setValue(this.plugin.settings.ignoredPaths.join('\n'))
        .onChange(async (value) => {
          this.plugin.settings.ignoredPaths = value.split('\n').map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    // ─── Advanced ───────────────────────────────────────
    containerEl.createEl('h3', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Sync Check Interval')
      .setDesc('Interval for periodic full sync check (in seconds). 0 to disable.')
      .addText(text => text
        .setValue(String(this.plugin.settings.syncIntervalMs / 1000))
        .onChange(async (value) => {
          const secs = parseInt(value, 10);
          if (!isNaN(secs) && secs >= 0) {
            this.plugin.settings.syncIntervalMs = secs * 1000;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Debug Logging')
      .setDesc('Enable verbose logging in the developer console.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableDebugLog)
        .onChange(async (value) => {
          this.plugin.settings.enableDebugLog = value;
          await this.plugin.saveSettings();
        }));
  }

  private _renderPeerList(container: HTMLElement): void {
    container.empty();
    for (let i = 0; i < this.plugin.settings.manualPeers.length; i++) {
      const peer = this.plugin.settings.manualPeers[i];
      const row = container.createDiv({ cls: 'lan-sync-peer-row' });
      row.createSpan({ text: peer });
      const removeBtn = row.createEl('button', { text: '✕', cls: 'lan-sync-peer-remove' });
      removeBtn.addEventListener('click', async () => {
        this.plugin.settings.manualPeers.splice(i, 1);
        await this.plugin.saveSettings();
        this._renderPeerList(container);
      });
    }
  }
}
