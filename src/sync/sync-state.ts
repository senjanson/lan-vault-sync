import { SyncState } from '../types';
import { logger } from '../logger';

type StateChangeHandler = (from: SyncState, to: SyncState) => void;

export class SyncStateMachine {
  private state: SyncState = 'idle';
  private handler: StateChangeHandler | null = null;

  onStateChange(handler: StateChangeHandler): void {
    this.handler = handler;
  }

  getState(): SyncState {
    return this.state;
  }

  transition(to: SyncState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    logger.info(`Sync state: ${from} → ${to}`);
    this.handler?.(from, to);
  }

  reset(): void {
    this.state = 'idle';
  }
}
