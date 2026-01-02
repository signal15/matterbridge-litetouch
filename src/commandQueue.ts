/**
 * Command queue with priority handling for Litetouch serial communication.
 * User-initiated commands (on/off, dimming) take priority over background polling.
 */

export enum CommandPriority {
  HIGH = 0,    // User-initiated commands (on/off, set level)
  NORMAL = 1,  // Polling commands
}

export interface QueuedCommand {
  command: string;
  priority: CommandPriority;
  resolve: (response: string | null) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

export class CommandQueue {
  private queue: QueuedCommand[] = [];
  private processing = false;
  private processCallback: ((cmd: QueuedCommand) => Promise<string | null>) | null = null;

  /**
   * Set the callback that processes commands (sends to serial port)
   */
  setProcessor(callback: (cmd: QueuedCommand) => Promise<string | null>): void {
    this.processCallback = callback;
  }

  /**
   * Add a command to the queue with specified priority.
   * High priority commands are inserted before normal priority ones.
   */
  async enqueue(command: string, priority: CommandPriority = CommandPriority.NORMAL): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const queuedCmd: QueuedCommand = {
        command,
        priority,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      // Insert based on priority
      if (priority === CommandPriority.HIGH) {
        // Find the first normal priority command and insert before it
        const insertIndex = this.queue.findIndex(cmd => cmd.priority === CommandPriority.NORMAL);
        if (insertIndex === -1) {
          this.queue.push(queuedCmd);
        } else {
          this.queue.splice(insertIndex, 0, queuedCmd);
        }
      } else {
        this.queue.push(queuedCmd);
      }

      // Start processing if not already running
      this.processNext();
    });
  }

  /**
   * Add a high-priority command (user action)
   */
  async enqueueHighPriority(command: string): Promise<string | null> {
    return this.enqueue(command, CommandPriority.HIGH);
  }

  /**
   * Add a normal-priority command (polling)
   */
  async enqueuePolling(command: string): Promise<string | null> {
    return this.enqueue(command, CommandPriority.NORMAL);
  }

  /**
   * Process the next command in the queue
   */
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0 || !this.processCallback) {
      return;
    }

    this.processing = true;
    const cmd = this.queue.shift()!;

    try {
      const response = await this.processCallback(cmd);
      cmd.resolve(response);
    } catch (error) {
      cmd.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.processing = false;
      // Process next command if queue is not empty
      if (this.queue.length > 0) {
        // Use setImmediate to prevent stack overflow on large queues
        setImmediate(() => this.processNext());
      }
    }
  }

  /**
   * Get the current queue length
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Check if currently processing a command
   */
  get isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Clear all pending commands (used during shutdown)
   */
  clear(): void {
    for (const cmd of this.queue) {
      cmd.reject(new Error('Queue cleared'));
    }
    this.queue = [];
  }

  /**
   * Remove all polling commands from the queue (useful when user commands come in)
   */
  clearPollingCommands(): void {
    this.queue = this.queue.filter(cmd => {
      if (cmd.priority === CommandPriority.NORMAL) {
        cmd.reject(new Error('Polling command cancelled'));
        return false;
      }
      return true;
    });
  }
}
