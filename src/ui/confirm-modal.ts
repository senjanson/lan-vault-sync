import { App, Modal, Setting } from "obsidian";

/** A yes/no dialog. Resolves true only when the user presses the confirm button. */
export function confirmDialog(
  app: App,
  title: string,
  lines: string[],
  confirmText: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new (class extends Modal {
      onOpen(): void {
        this.titleEl.setText(title);
        for (const line of lines) this.contentEl.createEl("p", { text: line });
        new Setting(this.contentEl)
          .addButton((b) =>
            b.setButtonText("Cancel").onClick(() => this.close()),
          )
          .addButton((b) =>
            b
              .setButtonText(confirmText)
              .setCta()
              .onClick(() => {
                answered = true;
                this.close();
              }),
          );
      }

      onClose(): void {
        this.contentEl.empty();
        resolve(answered);
      }
    })(app);
    modal.open();
  });
}
