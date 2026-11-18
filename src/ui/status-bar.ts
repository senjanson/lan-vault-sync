import { Plugin } from 'obsidian';
import { SyncState } from '../types';
import { t } from '../i18n';

export class StatusBar {
  private el: HTMLElement;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass('lan-sync-status');
    this.update('idle');
  }

  /** `unreachable`: addresses added by hand that keep failing to connect. */
  update(state: SyncState, peerCount = 0, unreachable: string[] = []): void {
    this.el.empty();

    const icon = this.el.createSpan({ cls: 'lan-sync-status-icon' });
    const text = this.el.createSpan({ cls: 'lan-sync-status-text' });

    switch (state) {
      case 'idle':
        icon.setText('⏸');
        text.setText(t('status.off'));
        break;
      case 'discovering':
        icon.setText('🔍');
        text.setText(t('status.searching'));
        break;
      case 'connecting':
        icon.setText('🔗');
        text.setText(t('status.connecting'));
        break;
      case 'initial-sync':
        icon.setText('🔄');
        text.setText(t('status.syncing'));
        break;
      case 'watching':
        icon.setText('✅');
        text.setText(t('status.peers', { count: peerCount }));
        break;
      case 'error':
        icon.setText('⚠️');
        text.setText(t('status.error'));
        break;
    }

    // Retries run quietly in the background, so without this a device that
    // cannot be reached (a phone without local network permission, say)
    // looks like one that simply has no peers.
    if (state !== 'idle' && unreachable.length > 0) {
      icon.setText('⚠️');
      const what = unreachable.length === 1 ? unreachable[0] : `${unreachable.length} devices`;
      text.setText(`${text.textContent} · ${t('status.unreachable', { what })}`);
      this.el.setAttribute('aria-label', `Cannot reach ${unreachable.join(', ')}. Retrying in the background.`);
    } else {
      this.el.removeAttribute('aria-label');
    }
  }
}
