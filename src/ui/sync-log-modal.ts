import { App, Modal, Notice, TFile } from 'obsidian';
import { SyncLogEntry } from '../types';
import { SyncLogService } from '../sync-log/sync-log-service';

interface DiffLine {
  type: 'add' | 'remove' | 'same';
  content: string;
}

export class SyncLogModal extends Modal {
  private activeTab: 'content' | 'diff' = 'content';

  constructor(
    app: App,
    private entry: SyncLogEntry,
    private syncLogService: SyncLogService,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass('sync-log-modal');
    this.titleEl.setText(`同步日志 — ${this.entry.path}`);
    await this.renderBody();
  }

  private async renderBody(): Promise<void> {
    this.contentEl.empty();

    // Tabs
    const tabBar = this.contentEl.createDiv({ cls: 'sync-log-modal-tabs' });
    const contentTab = tabBar.createEl('button', {
      text: '快照内容',
      cls: `sync-log-modal-tab ${this.activeTab === 'content' ? 'is-active' : ''}`,
    });
    const diffTab = tabBar.createEl('button', {
      text: '差异对比',
      cls: `sync-log-modal-tab ${this.activeTab === 'diff' ? 'is-active' : ''}`,
    });
    contentTab.addEventListener('click', () => {
      this.activeTab = 'content';
      this.renderBody();
    });
    diffTab.addEventListener('click', () => {
      this.activeTab = 'diff';
      this.renderBody();
    });

    // Body
    const body = this.contentEl.createDiv({ cls: 'sync-log-modal-body' });
    if (this.activeTab === 'content') {
      await this._renderContent(body);
    } else {
      await this._renderDiff(body);
    }

    // Bottom actions
    const actions = this.contentEl.createDiv({ cls: 'sync-log-modal-actions' });

    const restoreBtn = actions.createEl('button', { text: '还原', cls: 'mod-cta' });
    restoreBtn.addEventListener('click', async () => {
      const success = await this.syncLogService.restoreFromSnapshot(this.entry);
      new Notice(success ? `已还原: ${this.entry.path}` : `还原失败: ${this.entry.path}`);
      if (success) this.close();
    });

    const copyBtn = actions.createEl('button', { text: '复制内容' });
    copyBtn.addEventListener('click', async () => {
      const content = await this.syncLogService.readSnapshotContent(this.entry);
      if (content !== null) {
        await navigator.clipboard.writeText(content);
        new Notice('已复制到剪贴板');
      } else {
        new Notice('无法读取快照内容');
      }
    });

    const closeBtn = actions.createEl('button', { text: '关闭' });
    closeBtn.addEventListener('click', () => this.close());
  }

  private async _renderContent(container: HTMLElement): Promise<void> {
    const content = await this.syncLogService.readSnapshotContent(this.entry);
    if (content === null) {
      container.createEl('p', { text: '无法读取快照内容', cls: 'sync-log-modal-error' });
      return;
    }
    const pre = container.createEl('pre', { cls: 'sync-log-modal-content' });
    pre.createEl('code', { text: content });
  }

  private async _renderDiff(container: HTMLElement): Promise<void> {
    const snapshotContent = await this.syncLogService.readSnapshotContent(this.entry);
    if (snapshotContent === null) {
      container.createEl('p', { text: '无法读取快照内容', cls: 'sync-log-modal-error' });
      return;
    }

    let currentContent = '';
    const file = this.app.vault.getAbstractFileByPath(this.entry.path);
    if (file instanceof TFile) {
      currentContent = await this.app.vault.cachedRead(file);
    }

    // Label: "快照(旧) vs 当前(新)"
    container.createEl('p', {
      text: '红色 = 快照中有但当前没有，绿色 = 当前新增',
      cls: 'sync-log-diff-legend',
    });

    const diff = computeLineDiff(snapshotContent, currentContent);
    const diffContainer = container.createDiv({ cls: 'sync-log-diff' });

    for (const line of diff) {
      const lineEl = diffContainer.createDiv({ cls: `sync-log-diff-line sync-log-diff-${line.type}` });
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      lineEl.setText(`${prefix} ${line.content}`);
    }
  }
}

/**
 * Compute a line-level diff using LCS (Longest Common Subsequence).
 * Pure TypeScript, no external dependencies.
 */
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;

  // For very large files, cap the diff to avoid UI freeze
  if (n * m > 1_000_000) {
    return [
      { type: 'remove', content: `(文件过大，共 ${n} 行，已省略详细对比)` },
      { type: 'add', content: `(当前文件共 ${m} 行)` },
    ];
  }

  // Build LCS lengths table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Trace back to build diff
  const result: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'same', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', content: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'remove', content: oldLines[i - 1] });
      i--;
    }
  }

  return result;
}
