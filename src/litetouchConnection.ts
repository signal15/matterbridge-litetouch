/**
 * Litetouch 2000 serial communication handler.
 *
 * Protocol:
 * - ASCII over RS-232, carriage return (\r) terminated
 * - Commands start with a space, format: " XX YY-Z VVV"
 *   - XX: command code (10 = set, 18 = query)
 *   - YY-Z: module-output address (e.g., "01-1", "07-4")
 *   - VVV: value (000-001 for relays, 000-250 for dimmers)
 */

import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { EventEmitter } from 'events';
import { CommandQueue, type QueuedCommand } from './commandQueue.js';

export interface LoadStatus {
  address: string;
  level: number;  // 0-100 for percentage, or 0/1 for on/off
  raw: number;    // Raw Litetouch value (0-250 for dimmers, 0-1 for relays)
}

export interface LitetouchConfig {
  serialPort: string;
  baudRate: number;
  pollingInterval: number;
  commandTimeout: number;
  debug: boolean;
}

export class LitetouchConnection extends EventEmitter {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private commandQueue: CommandQueue;
  private config: LitetouchConfig;
  private pollingTimer: NodeJS.Timeout | null = null;
  private loadAddresses: string[] = [];
  private currentPollingIndex = 0;
  private pendingResponse: {
    resolve: (response: string | null) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    address?: string;  // Track the address for query commands
  } | null = null;
  private connected = false;

  constructor(config: LitetouchConfig) {
    super();
    this.config = config;
    this.commandQueue = new CommandQueue();
    this.commandQueue.setProcessor(this.processCommand.bind(this));
  }

  /**
   * Set the list of load addresses to poll
   */
  setLoadAddresses(addresses: string[]): void {
    this.loadAddresses = addresses;
    this.currentPollingIndex = 0;
  }

  /**
   * Open the serial port and start communication
   */
  async open(): Promise<void> {
    if (this.port?.isOpen) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: this.config.serialPort,
        baudRate: this.config.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      }, (err) => {
        if (err) {
          this.log(`Failed to open serial port: ${err.message}`);
          reject(err);
          return;
        }

        this.log(`Serial port opened: ${this.config.serialPort}`);
        this.setupParser();
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.port.on('error', (err) => {
        this.log(`Serial port error: ${err.message}`);
        this.emit('error', err);
      });

      this.port.on('close', () => {
        this.log('Serial port closed');
        this.connected = false;
        this.emit('disconnected');
      });
    });
  }

  /**
   * Set up the readline parser for CR-terminated messages
   */
  private setupParser(): void {
    if (!this.port) return;

    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r' }));
    this.parser.on('data', (data: string) => {
      this.handleResponse(data);
    });
  }

  /**
   * Handle incoming response from Litetouch
   */
  private handleResponse(data: string): void {
    const trimmed = data.trim();
    this.debug(`Received: "${trimmed}"`);

    // Capture pending address before clearing pendingResponse
    const pendingAddress = this.pendingResponse?.address;

    if (this.pendingResponse) {
      clearTimeout(this.pendingResponse.timeout);
      this.pendingResponse.resolve(trimmed);
      this.pendingResponse = null;
    }

    // Parse and emit status updates (pass the pending address for correlation)
    const status = this.parseStatusResponse(trimmed, pendingAddress);
    if (status) {
      this.emit('loadStatus', status);
    }
  }

  /**
   * Parse a status response from Litetouch
   * Response format: "18 VVV" where VVV is the level (000-250)
   * The address must be provided since responses don't include it
   */
  private parseStatusResponse(response: string, address?: string): LoadStatus | null {
    // Match response pattern: 18 VVV (command code echo followed by value)
    const match = response.match(/^18\s+(\d{3})$/);
    if (!match || !address) {
      return null;
    }

    const raw = parseInt(match[1], 10);

    // Convert raw value to percentage (0-250 -> 0-100)
    // For relays, 0=off, 1=on; for dimmers, 0-250 range
    const level = raw <= 1 ? raw * 100 : Math.round((raw / 250) * 100);

    return { address, level, raw };
  }

  /**
   * Process a command from the queue - sends it to the serial port
   */
  private async processCommand(cmd: QueuedCommand): Promise<string | null> {
    if (!this.port?.isOpen) {
      throw new Error('Serial port not open');
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = this.config.commandTimeout;

      // Extract address from query commands (format: " 18 MM-O")
      let address: string | undefined;
      const queryMatch = cmd.command.match(/^\s*18\s+(\d{1,2}-\d{1,2})/);
      if (queryMatch) {
        address = queryMatch[1];
      }

      // Set up timeout for response
      const timeout = setTimeout(() => {
        this.pendingResponse = null;
        this.debug(`Command timeout: "${cmd.command}"`);
        resolve(null); // Resolve with null on timeout instead of rejecting
      }, timeoutMs);

      this.pendingResponse = { resolve, reject, timeout, address };

      // Send command with carriage return terminator
      const fullCommand = `${cmd.command}\r`;
      this.debug(`Sending: "${cmd.command}"`);

      this.port!.write(fullCommand, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pendingResponse = null;
          reject(err);
        }
      });
    });
  }

  /**
   * Query the status of a load
   */
  async queryLoad(address: string): Promise<string | null> {
    const command = ` 18 ${address}`;
    return this.commandQueue.enqueuePolling(command);
  }

  /**
   * Set a relay on or off
   */
  async setRelay(address: string, on: boolean): Promise<string | null> {
    const value = on ? '001' : '000';
    const command = ` 10 ${address} ${value}`;
    return this.commandQueue.enqueueHighPriority(command);
  }

  /**
   * Set a dimmer level (0-100 percentage)
   */
  async setDimmer(address: string, level: number): Promise<string | null> {
    // Clamp to 0-100 and convert to 0-250 range
    const clampedLevel = Math.max(0, Math.min(100, level));
    const rawValue = Math.round((clampedLevel / 100) * 250);
    const value = rawValue.toString().padStart(3, '0');
    const command = ` 10 ${address} ${value}`;
    return this.commandQueue.enqueueHighPriority(command);
  }

  /**
   * Start the polling loop to query load statuses
   */
  startPolling(): void {
    if (this.pollingTimer) {
      return;
    }

    this.log(`Starting polling loop (${this.loadAddresses.length} loads, ${this.config.pollingInterval}ms interval)`);
    this.pollNextLoad();
  }

  /**
   * Poll the next load in the list
   */
  private pollNextLoad(): void {
    if (this.loadAddresses.length === 0) {
      // No loads to poll, check again later
      this.pollingTimer = setTimeout(() => this.pollNextLoad(), this.config.pollingInterval);
      return;
    }

    const address = this.loadAddresses[this.currentPollingIndex];
    this.currentPollingIndex = (this.currentPollingIndex + 1) % this.loadAddresses.length;

    this.queryLoad(address).catch((err) => {
      this.debug(`Polling error for ${address}: ${err.message}`);
    });

    // Schedule next poll
    this.pollingTimer = setTimeout(() => this.pollNextLoad(), this.config.pollingInterval);
  }

  /**
   * Stop the polling loop
   */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
      this.log('Polling stopped');
    }
  }

  /**
   * Close the serial port and clean up
   */
  async close(): Promise<void> {
    this.stopPolling();
    this.commandQueue.clear();

    if (this.pendingResponse) {
      clearTimeout(this.pendingResponse.timeout);
      this.pendingResponse.reject(new Error('Connection closing'));
      this.pendingResponse = null;
    }

    if (this.port?.isOpen) {
      return new Promise((resolve) => {
        this.port!.close((err) => {
          if (err) {
            this.log(`Error closing port: ${err.message}`);
          }
          this.port = null;
          this.parser = null;
          this.connected = false;
          resolve();
        });
      });
    }

    this.port = null;
    this.parser = null;
  }

  /**
   * Check if the connection is open
   */
  get isConnected(): boolean {
    return this.connected && !!this.port?.isOpen;
  }

  /**
   * Get the command queue length
   */
  get queueLength(): number {
    return this.commandQueue.length;
  }

  private log(message: string): void {
    console.log(`[Litetouch] ${message}`);
  }

  private debug(message: string): void {
    if (this.config.debug) {
      console.log(`[Litetouch:Debug] ${message}`);
    }
  }
}
