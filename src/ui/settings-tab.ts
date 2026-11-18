import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LANSyncPlugin from "../main";
import { getLocalIPv4Addresses } from "../utils/network";
import { supportsIncomingConnections } from "../utils/runtime";
import { buildPeerURI, renderQRCode } from "./qr-code";
import { generateSyncKey } from "../transport/auth";
import { t } from "../i18n";

function makeCopyable(el: HTMLElement, getText: () => string): void {
  el.addClass("lan-sync-copyable");
  el.setAttribute("title", t("common.clickToCopy"));
  el.addEventListener("click", () => {
    navigator.clipboard
      .writeText(getText())
      .then(() => {
        new Notice(t("common.copied"), 1500);
      })
      .catch(() => {
        new Notice(t("common.copyFailed"), 2000);
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
      .setName(t("set.enable"))
      .setDesc(t("set.enableDesc"))
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
      .setName(t("set.deviceName"))
      .setDesc(t("set.deviceNameDesc"))
      .addText((text) =>
        text
          .setPlaceholder(t("set.deviceNamePlaceholder"))
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value;
            await this.plugin.saveSettings();
            this.plugin.restartSyncSoon();
          }),
      );

    new Setting(containerEl)
      .setName(t("set.port"))
      .setDesc(
        canAcceptIncoming
          ? t("set.portDesc")
          : t("set.portDescOutbound"),
      )
      .addText((text) =>
        text
          .setPlaceholder(t("set.portPlaceholder"))
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
    new Setting(containerEl).setName(t("set.syncKey")).setHeading();
    containerEl.createEl("p", {
      text: t("set.syncKeyIntro"),
      cls: "setting-item-description",
    });
    let keyInput: { setValue(v: string): unknown } | null = null;
    new Setting(containerEl)
      .setName(t("set.syncKey"))
      .setDesc(t("set.syncKeyDesc"))
      .addText((text) => {
        keyInput = text;
        text.setValue(this.plugin.settings.syncKey);
        text.inputEl.addEventListener("change", async () => {
          const ok = await this.plugin.setSyncKey(text.getValue());
          if (!ok) {
            new Notice(t("set.syncKeyTooShort"));
            text.setValue(this.plugin.settings.syncKey);
          } else {
            this.display();
          }
        });
      })
      .addButton((button) =>
        button.setButtonText(t("common.copy")).onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.settings.syncKey);
          new Notice(t("set.syncKeyCopied"));
        }),
      )
      .addButton((button) =>
        button.setButtonText(t("set.newKey")).onClick(async () => {
          await this.plugin.setSyncKey(generateSyncKey());
          keyInput?.setValue(this.plugin.settings.syncKey);
          new Notice(t("set.newKeySet"));
          this.display();
        }),
      );

    // ─── QR Code (Share This Device) ───────────────────
    new Setting(containerEl).setName(t("set.qrHeading")).setHeading();
    if (!canAcceptIncoming) {
      containerEl.createEl("p", {
        text: t("set.qrOutbound"),
        cls: "setting-item-description",
      });
    } else {
      containerEl.createEl("p", {
        text: t("set.qrIntro"),
        cls: "setting-item-description",
      });

      const ips = getLocalIPv4Addresses();

      if (ips.length === 0) {
        containerEl.createEl("p", {
          text: t("set.qrNoIp"),
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
            text: t("set.qrAddress", { address: `${ip}:${currentPort}` }),
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
            .setName(t("set.networkInterface"))
            .setDesc(t("set.networkInterfaceDesc"))
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
    new Setting(containerEl).setName(t("set.peersHeading")).setHeading();
    containerEl.createEl("p", {
      text: t("set.peersIntro"),
      cls: "setting-item-description",
    });

    const peerContainer = containerEl.createDiv();
    this._renderPeerList(peerContainer);

    let peerTextInput: import("obsidian").TextComponent;
    new Setting(containerEl)
      .setName(t("set.addDevice"))
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
        btn.setButtonText(t("common.add")).onClick(async () => {
          await this.addPeerFromInput(
            peerTextInput.getValue(),
            peerContainer,
            () => peerTextInput.setValue(""),
          );
        }),
      );

    // ─── Ignored Paths ──────────────────────────────────
    new Setting(containerEl).setName(t("set.ignoredHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("set.ignoredHeading"))
      .setDesc(
        t("set.ignoredDesc"),
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
    new Setting(containerEl).setName(t("set.manualHeading")).setHeading();

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
    progressLabel.setText(t("set.manualHint"));

    let isSyncing = false;

    new Setting(syncContainer)
      .setName(t("set.fullSync"))
      .setDesc(t("set.fullSyncDesc"))
      .addButton((btn) => {
        btn
          .setButtonText(t("set.syncNow"))
          .setCta()
          .onClick(async () => {
            if (isSyncing) return;
            isSyncing = true;
            btn.setDisabled(true);
            btn.setButtonText(t("set.syncing"));
            progressBarInner.style.width = "0%";
            progressBarInner.removeClass("lan-sync-progress-complete");
            progressLabel.setText(t("set.starting"));

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
              new Notice(t("set.syncDone"));
            } catch (err) {
              progressLabel.setText(t("set.syncFailedLabel"));
              progressBarInner.style.width = "100%";
              progressBarInner.addClass("lan-sync-progress-error");
              new Notice(t("set.syncFailed"));
            } finally {
              isSyncing = false;
              btn.setDisabled(false);
              btn.setButtonText(t("set.syncNow"));
            }
          });
      });

    // ─── Advanced ───────────────────────────────────────
    new Setting(containerEl).setName(t("set.advanced")).setHeading();

    new Setting(containerEl)
      .setName(t("set.interval"))
      .setDesc(
        t("set.intervalDesc"),
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
      .setName(t("set.debug"))
      .setDesc(t("set.debugDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDebugLog)
          .onChange(async (value) => {
            this.plugin.settings.enableDebugLog = value;
            await this.plugin.saveSettings();
          }),
      );

    // ─── Version history ────────────────────────────────
    new Setting(containerEl).setName(t("set.historyHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("set.historyKeepDays"))
      .setDesc(t("set.historyKeepDaysDesc"))
      .addText((text) =>
        text.setValue(String(this.plugin.settings.historyKeepDays)).onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 1 && num <= 3650) {
            this.plugin.settings.historyKeepDays = num;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName(t("set.historyMaxMB"))
      .setDesc(t("set.historyMaxMBDesc"))
      .addText((text) =>
        text.setValue(String(this.plugin.settings.historyMaxMB)).onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 0) {
            this.plugin.settings.historyMaxMB = num;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName(t("set.recoveryOpen"))
      .setDesc(t("set.recoveryOpenDesc"))
      .addButton((btn) =>
        btn.setButtonText(t("common.open")).onClick(() => {
          void this.plugin.activateRecoveryCenter();
        }),
      );

    // ─── Sync Log ───────────────────────────────────────
    new Setting(containerEl).setName(t("set.logHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("set.logEnable"))
      .setDesc(t("set.logEnableDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSyncLog)
          .onChange(async (value) => {
            this.plugin.settings.enableSyncLog = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("set.logMax"))
      .setDesc(t("set.logMaxDesc"))
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
      .setName(t("set.logOpen"))
      .setDesc(t("set.logOpenDesc"))
      .addButton((btn) =>
        btn.setButtonText(t("common.open")).onClick(() => {
          this.plugin.activateSyncLogView();
        }),
      );

    new Setting(containerEl)
      .setName(t("set.logClear"))
      .setDesc(t("set.logClearDesc"))
      .addButton((btn) =>
        btn
          .setButtonText(t("common.clear"))
          .setWarning()
          .onClick(async () => {
            await this.plugin.syncLogService?.clearAll();
            new Notice(t("set.logCleared"));
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
