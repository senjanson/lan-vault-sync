import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LANSyncPlugin from "../main";
import { getLocalIPv4Addresses } from "../utils/network";
import { supportsIncomingConnections } from "../utils/runtime";
import { buildPeerURI, renderQRCode } from "./qr-code";
import { generateSyncKey } from "../transport/auth";

function makeCopyable(el: HTMLElement, getText: () => string): void {
  el.addClass("lan-sync-copyable");
  el.setAttribute("title", "点击复制 / Click to copy");
  el.addEventListener("click", () => {
    navigator.clipboard
      .writeText(getText())
      .then(() => {
        new Notice("已复制到剪贴板", 1500);
      })
      .catch(() => {
        new Notice("复制失败，请手动选中文本", 2000);
      });
  });
}

export class LANSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LANSyncPlugin,
  ) {
    super(app, plugin);
  }

  private async addPeerFromInput(
    value: string,
    container: HTMLElement,
    clear: () => void,
  ): Promise<void> {
    const added = await this.plugin.addManualPeer(value);
    if (!added) return;

    clear();
    this._renderPeerList(container);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const canAcceptIncoming = supportsIncomingConnections();


    new Setting(containerEl)
      .setName("Enable sync")
      .setDesc("Turn LAN Vault Sync on or off.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value;
            await this.plugin.saveSettings();
            if (value) {
              await this.plugin.startSync();
            } else {
              await this.plugin.stopSync();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("A friendly name for this device.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. MacBook Pro")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value;
            await this.plugin.saveSettings();
            this.plugin.restartSyncSoon();
          }),
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc(
        canAcceptIncoming
          ? "WebSocket port for sync. Other devices that use a manual address must be given the new port."
          : "This device cannot accept incoming connections. Keep this port aligned with your desktop peers if needed.",
      )
      .addText((text) =>
        text
          .setPlaceholder("auto-assigned")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (!isNaN(port) && port > 1024 && port < 65536) {
              this.plugin.settings.port = port;
              await this.plugin.saveSettings();
              this.plugin.restartSyncSoon();
            }
          }),
      );

    // ─── Sync key ───────────────────────────────────────
    new Setting(containerEl).setName("Sync key").setHeading();
    containerEl.createEl("p", {
      text: "Only devices with the same sync key can connect to each other. Scanning this device's QR code copies the key; otherwise enter the same key on every device. Note that synced data is still sent unencrypted on your network.",
      cls: "setting-item-description",
    });
    let keyInput: { setValue(v: string): unknown } | null = null;
    new Setting(containerEl)
      .setName("Sync key")
      .setDesc("Changing it reconnects with the new key when you leave the field.")
      .addText((text) => {
        keyInput = text;
        text.setValue(this.plugin.settings.syncKey);
        text.inputEl.addEventListener("change", async () => {
          const ok = await this.plugin.setSyncKey(text.getValue());
          if (!ok) {
            new Notice("LAN Sync: the sync key needs at least 8 letters or digits");
            text.setValue(this.plugin.settings.syncKey);
          } else {
            this.display();
          }
        });
      })
      .addButton((button) =>
        button.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.settings.syncKey);
          new Notice("LAN Sync: sync key copied");
        }),
      )
      .addButton((button) =>
        button.setButtonText("New key").onClick(async () => {
          await this.plugin.setSyncKey(generateSyncKey());
          keyInput?.setValue(this.plugin.settings.syncKey);
          new Notice("LAN Sync: new sync key set. Pair your other devices again.");
          this.display();
        }),
      );

    // ─── QR Code (Share This Device) ───────────────────
    new Setting(containerEl).setName("Pair with QR code").setHeading();
    if (!canAcceptIncoming) {
      containerEl.createEl("p", {
        text: "This device is running in outbound-only mode. On iPhone/iPad, please scan the QR code shown on a desktop device or add the desktop peer manually.",
        cls: "setting-item-description",
      });
    } else {
      containerEl.createEl("p", {
        text: "Let another device scan this QR code to quickly add this device as a peer.",
        cls: "setting-item-description",
      });

      const ips = getLocalIPv4Addresses();

      if (ips.length === 0) {
        containerEl.createEl("p", {
          text: "Unable to detect local IP address. QR code pairing requires a network connection.",
          cls: "setting-item-description",
        });
      } else {
        const qrWrapper = containerEl.createDiv({ cls: "lan-sync-qr-section" });

        // Dropdown comes first so user picks IP before seeing the QR
        const qrCanvas = qrWrapper.createDiv({ cls: "lan-sync-qr-canvas" });
        const qrInfo = qrWrapper.createDiv({ cls: "lan-sync-qr-info" });

        let selectedIP = ips[0];

        const updateQR = async (ip: string) => {
          selectedIP = ip;
          // Always read the current port from settings (may have changed on this page)
          const currentPort = this.plugin.settings.port;
          const uri = buildPeerURI(ip, currentPort, this.plugin.settings.syncKey);
          qrInfo.empty();
          const addrEl = qrInfo.createEl("p", {
            text: `Address: ${ip}:${currentPort}`,
            cls: "lan-sync-qr-address",
          });
          makeCopyable(addrEl, () => `${ip}:${currentPort}`);
          const uriEl = qrInfo.createEl("p", {
            text: uri,
            cls: "lan-sync-qr-uri setting-item-description",
          });
          makeCopyable(uriEl, () => uri);
          await renderQRCode(qrCanvas, uri);
        };

        if (ips.length > 1) {
          new Setting(qrWrapper)
            .setName("Network interface")
            .setDesc("Select which IP address to use.")
            .addDropdown((drop) => {
              for (const ip of ips) {
                drop.addOption(ip, ip);
              }
              drop.setValue(selectedIP);
              drop.onChange(async (value) => {
                await updateQR(value);
              });
            });
          // Move the QR canvas/info below the dropdown
          qrWrapper.appendChild(qrCanvas);
          qrWrapper.appendChild(qrInfo);
        }

        // Initial render — fire-and-forget (renderQRCode errors are non-critical)
        void updateQR(selectedIP);
      }
    }

    // ─── Manual Peers ───────────────────────────────────
    new Setting(containerEl).setName("Devices by address").setHeading();
    containerEl.createEl("p", {
      text: "Add peers manually if auto-discovery doesn't work. Format: ip:port",
      cls: "setting-item-description",
    });

    const peerContainer = containerEl.createDiv();
    this._renderPeerList(peerContainer);

    let peerTextInput: import("obsidian").TextComponent;
    new Setting(containerEl)
      .setName("Add device")
      .addText((text) => {
        peerTextInput = text;
        text.setPlaceholder("192.168.1.100:53712");
        text.inputEl.addEventListener("keydown", async (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            await this.addPeerFromInput(text.getValue(), peerContainer, () =>
              text.setValue(""),
            );
          }
        });
      })
      .addButton((btn) =>
        btn.setButtonText("Add").onClick(async () => {
          await this.addPeerFromInput(
            peerTextInput.getValue(),
            peerContainer,
            () => peerTextInput.setValue(""),
          );
        }),
      );

    // ─── Ignored Paths ──────────────────────────────────
    new Setting(containerEl).setName("Ignored paths").setHeading();

    new Setting(containerEl)
      .setName("Ignored paths")
      .setDesc(
        "Paths to exclude from sync (one per line). Paths ending with / match directories.",
      )
      .addTextArea((text) =>
        text
          .setPlaceholder(".obsidian/\n.trash/")
          .setValue(this.plugin.settings.ignoredPaths.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.ignoredPaths = value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
            this.plugin.applyIgnoredPaths();
          }),
      );

    // ─── Manual Sync ─────────────────────────────────────
    new Setting(containerEl).setName("Manual sync").setHeading();

    const syncContainer = containerEl.createDiv({
      cls: "lan-sync-manual-sync",
    });

    const progressBarOuter = syncContainer.createDiv({
      cls: "lan-sync-progress-bar-outer",
    });
    const progressBarInner = progressBarOuter.createDiv({
      cls: "lan-sync-progress-bar-inner",
    });
    progressBarInner.style.width = "0%";

    const progressLabel = syncContainer.createDiv({
      cls: "lan-sync-progress-label",
    });
    progressLabel.setText('Click "Sync Now" to start a full sync.');

    let isSyncing = false;

    new Setting(syncContainer)
      .setName("Full sync")
      .setDesc("Manually trigger a full sync with all connected peers.")
      .addButton((btn) => {
        btn
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            if (isSyncing) return;
            isSyncing = true;
            btn.setDisabled(true);
            btn.setButtonText("Syncing...");
            progressBarInner.style.width = "0%";
            progressBarInner.removeClass("lan-sync-progress-complete");
            progressLabel.setText("Starting...");

            try {
              await this.plugin.manualFullSync(
                (percent: number, message: string) => {
                  progressBarInner.style.width = `${percent}%`;
                  progressLabel.setText(`${Math.round(percent)}% — ${message}`);
                  if (percent >= 100) {
                    progressBarInner.addClass("lan-sync-progress-complete");
                  }
                },
              );
              new Notice("LAN Sync: Full sync complete!");
            } catch (err) {
              progressLabel.setText("Sync failed. Check console for details.");
              progressBarInner.style.width = "100%";
              progressBarInner.addClass("lan-sync-progress-error");
              new Notice("LAN Sync: Sync failed!");
            } finally {
              isSyncing = false;
              btn.setDisabled(false);
              btn.setButtonText("Sync now");
            }
          });
      });

    // ─── Advanced ───────────────────────────────────────
    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Sync check interval")
      .setDesc(
        "Interval for periodic full sync check (in seconds). 0 to disable.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.syncIntervalMs / 1000))
          .onChange(async (value) => {
            const secs = parseInt(value, 10);
            if (!isNaN(secs) && secs >= 0) {
              this.plugin.settings.syncIntervalMs = secs * 1000;
              await this.plugin.saveSettings();
              this.plugin.applySyncInterval();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Enable verbose logging in the developer console.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDebugLog)
          .onChange(async (value) => {
            this.plugin.settings.enableDebugLog = value;
            await this.plugin.saveSettings();
          }),
      );

    // ─── Sync Log ───────────────────────────────────────
    new Setting(containerEl).setName("Sync log").setHeading();

    new Setting(containerEl)
      .setName("Enable sync log")
      .setDesc("Record all sync operations for review and restoration.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSyncLog)
          .onChange(async (value) => {
            this.plugin.settings.enableSyncLog = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max log entries")
      .setDesc("Maximum number of sync log entries to keep.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxSyncLogEntries))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0 && num <= 10000) {
              this.plugin.settings.maxSyncLogEntries = num;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Open sync log")
      .setDesc("View all sync operations in a side panel.")
      .addButton((btn) =>
        btn.setButtonText("Open").onClick(() => {
          this.plugin.activateSyncLogView();
        }),
      );

    new Setting(containerEl)
      .setName("Clear sync log")
      .setDesc("Delete all sync log entries.")
      .addButton((btn) =>
        btn
          .setButtonText("Clear")
          .setWarning()
          .onClick(async () => {
            await this.plugin.syncLogService?.clearAll();
            new Notice("Sync log cleared");
          }),
      );
  }

  private _renderPeerList(container: HTMLElement): void {
    container.empty();
    for (let i = 0; i < this.plugin.settings.manualPeers.length; i++) {
      const peer = this.plugin.settings.manualPeers[i];
      const row = container.createDiv({ cls: "lan-sync-peer-row" });
      const peerSpan = row.createSpan({ text: peer });
      makeCopyable(peerSpan, () => peer);
      const removeBtn = row.createEl("button", {
        text: "✕",
        cls: "lan-sync-peer-remove",
      });
      removeBtn.addEventListener("click", async () => {
        await this.plugin.removeManualPeer(peer);
        this._renderPeerList(container);
      });
    }
  }
}
