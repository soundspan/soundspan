/**
 * Operation Lock
 *
 * Prevents race conditions between load/play/pause/seek operations.
 * Each operation gets a unique ID to detect staleness.
 */

export type OperationType = 'load' | 'play' | 'pause' | 'seek' | 'stop';

interface PendingOperation {
  resolve: () => void;
  type: OperationType;
}

export class OperationLock {
  private currentOp: OperationType | null = null;
  private opId = 0;
  private waitQueue: PendingOperation[] = [];
  private debugEnabled: boolean = false;

  constructor() {
    if (typeof window !== 'undefined') {
      this.debugEnabled = localStorage.getItem('soundspanAudioDebug') === '1';
    }
  }

  /**
   * Acquire lock for an operation
   * Returns operation ID if acquired, null if should wait
   */
  acquire(op: OperationType): number | null {
    // Load and stop always win - they cancel current operation
    if (op === 'load' || op === 'stop') {
      this.cancelWaiting();
      this.currentOp = op;
      this.opId++;

      if (this.debugEnabled) {
        console.log(`[OpLock] Acquired: ${op} (id: ${this.opId})`);
      }
      return this.opId;
    }

    // Seek can interrupt play/pause but not load
    if (op === 'seek') {
      if (this.currentOp === 'load') {
        if (this.debugEnabled) {
          console.log(`[OpLock] Denied seek - load in progress`);
        }
        return null;
      }
      this.currentOp = op;
      this.opId++;

      if (this.debugEnabled) {
        console.log(`[OpLock] Acquired: ${op} (id: ${this.opId})`);
      }
      return this.opId;
    }

    // Play/pause must wait for seek/load to complete
    if (this.currentOp === 'seek' || this.currentOp === 'load') {
      if (this.debugEnabled) {
        console.log(`[OpLock] ${op} waiting for ${this.currentOp}`);
      }
      return null;
    }

    this.currentOp = op;
    this.opId++;

    if (this.debugEnabled) {
      console.log(`[OpLock] Acquired: ${op} (id: ${this.opId})`);
    }
    return this.opId;
  }

  /**
   * Acquire lock, waiting if necessary
   */
  async acquireAsync(op: OperationType): Promise<number> {
    const id = this.acquire(op);
    if (id !== null) return id;

    // Wait for current operation to complete
    return new Promise<number>((resolve) => {
      this.waitQueue.push({
        resolve: () => {
          const newId = this.acquire(op);
          if (newId !== null) {
            resolve(newId);
          }
        },
        type: op,
      });
    });
  }

  /**
   * Release lock for an operation
   */
  release(id: number): void {
    if (this.opId !== id) {
      // Stale release - operation was superseded
      return;
    }

    if (this.debugEnabled) {
      console.log(`[OpLock] Released: ${this.currentOp} (id: ${id})`);
    }

    this.currentOp = null;

    // Process waiting operations
    const next = this.waitQueue.shift();
    if (next) {
      next.resolve();
    }
  }

  /**
   * Check if an operation ID is stale
   */
  isStale(id: number): boolean {
    return this.opId !== id;
  }

  /**
   * Get current operation type
   */
  getCurrentOp(): OperationType | null {
    return this.currentOp;
  }

  /**
   * Get current operation ID
   */
  getCurrentId(): number {
    return this.opId;
  }

  /**
   * Cancel all waiting operations
   */
  private cancelWaiting(): void {
    this.waitQueue = [];
  }

  /**
   * Reset the lock state
   */
  reset(): void {
    this.currentOp = null;
    this.opId = 0;
    this.cancelWaiting();
  }
}

// Singleton instance
export const operationLock = new OperationLock();
