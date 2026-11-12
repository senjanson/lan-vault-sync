import { App, Modal, Setting } from "obsidian";

/**
 * Ask for one line of text. Resolves with the text, or null when the dialog
 * is closed without confirming. (window.prompt() is not available in
 * Obsidian.)
 */
export function textInputDialog(
  app: App,
  title: string,
  placeholder: string,
  confirmText: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let value = "";
    let answered = false;
    const modal = new (class extends Modal {
      onOpen(): void {
        this.titleEl.setText(title);
        const submit = () => {
          answered = true;
          this.close();
        };
        new Setting(this.contentEl).addText((text) => {
          text.setPlaceholder(placeholder).onChange((v) => (value = v));
          text.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") submit();
          });
          window.setTimeout(() => text.inputEl.focus(), 0);
        });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
          .addButton((b) => b.setButtonText(confirmText).setCta().onClick(submit));
      }

      onClose(): void {
        this.contentEl.empty();
        resolve(answered ? value.trim() : null);
      }
    })(app);
    modal.open();
  });
}
