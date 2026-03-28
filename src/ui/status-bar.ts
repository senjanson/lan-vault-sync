import { Plugin } from 'obsidian';
import { SyncState } from '../types';

export class StatusBar {
  private el: HTMLElement;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass('lan-sync-status');
    this.update('idle');
  }

  update(state: SyncState, peerCount = 0): void {
    this.el.empty();

    const icon = this.el.createSpan({ cls: 'lan-sync-status-icon' });
    const text = this.el.createSpan({ cls: 'lan-sync-status-text' });

    switch (state) {
      case 'idle':
        icon.setText('⏸');
        text.setText('LAN Sync: Off');
        break;
      case 'discovering':
        icon.setText('🔍');
        text.setText('LAN Sync: Searching...');
        break;
      case 'connecting':
        icon.setText('🔗');
        text.setText('LAN Sync: Connecting...');
        break;
      case 'initial-sync':
        icon.setText('🔄');
        text.setText('LAN Sync: Syncing...');
        break;
      case 'watching':
        icon.setText('✅');
        text.setText(`LAN Sync: ${peerCount} peer${peerCount !== 1 ? 's' : ''}`);
        break;
      case 'error':
        icon.setText('⚠️');
        text.setText('LAN Sync: Error');
        break;
    }
  }
}
