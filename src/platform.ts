/**
 * Matterbridge Dynamic Platform for Litetouch 2000 Lighting System
 *
 * Creates Matter devices for each configured dimmer and switch load,
 * handles commands from Matter controllers, and polls for status updates.
 */

import {
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformConfig,
  PlatformMatterbridge,
  onOffLight,
  dimmableLight,
  bridgedNode,
} from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { OnOff, LevelControl } from 'matterbridge/matter/clusters';
import { LitetouchConnection, type LoadStatus, type LitetouchConfig, type DeviceType } from './litetouchConnection.js';

interface LoadDefinition {
  address: string;
  name: string;
}

interface LitetouchPlatformConfig extends PlatformConfig {
  serialPort: string;
  baudRate: number;
  pollingInterval: number;
  commandTimeout: number;
  dimmers: LoadDefinition[];
  switches: LoadDefinition[];
  debug: boolean;
}

export class LitetouchPlatform extends MatterbridgeDynamicPlatform {
  private connection: LitetouchConnection | null = null;
  private devices: Map<string, MatterbridgeEndpoint> = new Map();
  private deviceTypes: Map<string, 'dimmer' | 'switch'> = new Map();
  // Track last known brightness level for each dimmer (0-100%)
  // Used to restore brightness on 'on' command instead of going to 100%
  private lastDimmerLevels: Map<string, number> = new Map();
  // Pending 'on' commands - delayed to allow level commands to override
  // Apple Home sends 'on' BEFORE moveToLevelWithOnOff, causing a flash
  private pendingOnTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    this.log.logName = 'LitetouchPlatform';
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting Litetouch platform${reason ? ` (${reason})` : ''}`);

    const config = this.config as LitetouchPlatformConfig;

    // Validate configuration
    if (!config.serialPort) {
      this.log.error('Serial port not configured');
      return;
    }

    const dimmers = config.dimmers || [];
    const switches = config.switches || [];

    if (dimmers.length === 0 && switches.length === 0) {
      this.log.warn('No loads configured');
      return;
    }

    // Create Matter devices for each load
    await this.createDevices(dimmers, switches);

    // Set up serial connection
    const connectionConfig: LitetouchConfig = {
      serialPort: config.serialPort,
      baudRate: config.baudRate || 9600,
      pollingInterval: config.pollingInterval || 2000,
      commandTimeout: config.commandTimeout || 1000,
      debug: config.debug || false,
    };

    this.connection = new LitetouchConnection(connectionConfig);

    // Set up all load addresses for polling with device type info
    const allAddresses = [
      ...dimmers.map(d => d.address),
      ...switches.map(s => s.address),
    ];
    // Convert deviceTypes to the format expected by LitetouchConnection
    const deviceTypeMap = new Map<string, DeviceType>();
    for (const [address, type] of this.deviceTypes) {
      deviceTypeMap.set(address, type);
    }
    this.connection.setLoadAddresses(allAddresses, deviceTypeMap);

    // Handle status updates from polling
    this.connection.on('loadStatus', (status: LoadStatus) => {
      this.handleLoadStatus(status);
    });

    this.connection.on('error', (err: Error) => {
      this.log.error(`Connection error: ${err.message}`);
    });

    // Open connection
    try {
      await this.connection.open();
      this.log.info('Serial connection established');
    } catch (err) {
      this.log.error(`Failed to open serial port: ${err}`);
    }
  }

  /**
   * Create Matter devices for all configured loads
   */
  private async createDevices(dimmers: LoadDefinition[], switches: LoadDefinition[]): Promise<void> {
    // Create dimmer devices
    for (const dimmer of dimmers) {
      const device = await this.createDimmerDevice(dimmer);
      this.devices.set(dimmer.address, device);
      this.deviceTypes.set(dimmer.address, 'dimmer');
    }

    // Create switch devices
    for (const sw of switches) {
      const device = await this.createSwitchDevice(sw);
      this.devices.set(sw.address, device);
      this.deviceTypes.set(sw.address, 'switch');
    }

    this.log.info(`Created ${dimmers.length} dimmers and ${switches.length} switches`);
  }

  /**
   * Create a dimmable light device
   */
  private async createDimmerDevice(load: LoadDefinition): Promise<MatterbridgeEndpoint> {
    const config = this.config as LitetouchPlatformConfig;

    // Create dimmable light device with bridgedNode device type
    // bridgedNode MUST be included for proper bridge mode operation
    const device = new MatterbridgeEndpoint(
      [bridgedNode, dimmableLight],
      { id: `dimmer-${load.address}` },
      config.debug || false,
    );

    // Add bridged device basic information using fluent API
    device
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        load.name,
        `lt-${load.address}`,
        0x0001,  // Vendor ID
        'Litetouch',
        load.address,
      )
      .addRequiredClusterServers();

    // Add command handlers
    device.addCommandHandler('on', async () => {
      // Apple Home sends 'on' BEFORE moveToLevelWithOnOff, which causes a flash
      // Delay the 'on' command to allow a level command to override it
      const existingTimer = this.pendingOnTimers.get(load.address);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const lastLevel = this.lastDimmerLevels.get(load.address) || 100;
      this.log.debug(`Dimmer ${load.address} ON command -> delaying (will restore to ${lastLevel}%)`);

      const timer = setTimeout(async () => {
        this.pendingOnTimers.delete(load.address);
        this.log.debug(`Dimmer ${load.address} ON command executing -> ${lastLevel}%`);
        await this.setDimmerLevel(load.address, lastLevel);
      }, 150); // Wait 150ms for a level command to arrive

      this.pendingOnTimers.set(load.address, timer);
    });
    device.addCommandHandler('off', async () => {
      // Cancel any pending 'on' command to prevent it firing after this off
      const pendingTimer = this.pendingOnTimers.get(load.address);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.pendingOnTimers.delete(load.address);
        this.log.debug(`Dimmer ${load.address} cancelled pending ON`);
      }
      this.log.debug(`Dimmer ${load.address} OFF command`);
      await this.setDimmerLevel(load.address, 0);
    });
    device.addCommandHandler('toggle', async () => {
      // Use OnOff cluster state, not currentLevel (which retains last value when off)
      const isOn = device.getAttribute(OnOff.Cluster.id, 'onOff') as boolean;
      if (isOn) {
        this.log.debug(`Dimmer ${load.address} TOGGLE command -> OFF`);
        await this.setDimmerLevel(load.address, 0);
      } else {
        const lastLevel = this.lastDimmerLevels.get(load.address) || 100;
        this.log.debug(`Dimmer ${load.address} TOGGLE command -> ${lastLevel}%`);
        await this.setDimmerLevel(load.address, lastLevel);
      }
    });
    device.addCommandHandler('moveToLevel', async ({ request }) => {
      const level = Math.round((request.level / 254) * 100);
      // Cancel any pending 'on' command - this level command takes precedence
      const pendingTimer = this.pendingOnTimers.get(load.address);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.pendingOnTimers.delete(load.address);
        this.log.debug(`Dimmer ${load.address} cancelled pending ON`);
      }
      this.log.debug(`Dimmer ${load.address} MOVE_TO_LEVEL command: ${level}%`);
      await this.setDimmerLevel(load.address, level);
    });
    device.addCommandHandler('moveToLevelWithOnOff', async ({ request }) => {
      const level = Math.round((request.level / 254) * 100);
      // Cancel any pending 'on' command - this level command takes precedence
      const pendingTimer = this.pendingOnTimers.get(load.address);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.pendingOnTimers.delete(load.address);
        this.log.debug(`Dimmer ${load.address} cancelled pending ON`);
      }
      this.log.debug(`Dimmer ${load.address} MOVE_TO_LEVEL_WITH_ONOFF command: ${level}%`);
      await this.setDimmerLevel(load.address, level);
    });

    // Register device immediately - Matterbridge 3.3.8 expects this in onStart
    try {
      await this.registerDevice(device);
      this.log.info(`Registered dimmer device: ${load.name}`);
    } catch (err) {
      this.log.error(`Failed to register dimmer ${load.name}: ${err}`);
    }
    return device;
  }

  /**
   * Create an on/off switch device
   */
  private async createSwitchDevice(load: LoadDefinition): Promise<MatterbridgeEndpoint> {
    const config = this.config as LitetouchPlatformConfig;

    // Create on/off light device with bridgedNode device type
    // bridgedNode MUST be included for proper bridge mode operation
    const device = new MatterbridgeEndpoint(
      [bridgedNode, onOffLight],
      { id: `switch-${load.address}` },
      config.debug || false,
    );

    // Add bridged device basic information using fluent API
    device
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        load.name,
        `lt-${load.address}`,
        0x0001,
        'Litetouch',
        load.address,
      )
      .addRequiredClusterServers();

    // Add command handlers
    device.addCommandHandler('on', async () => {
      this.log.debug(`Switch ${load.address} ON command`);
      await this.setSwitch(load.address, true);
    });
    device.addCommandHandler('off', async () => {
      this.log.debug(`Switch ${load.address} OFF command`);
      await this.setSwitch(load.address, false);
    });
    device.addCommandHandler('toggle', async () => {
      const currentState = device.getAttribute(OnOff.Cluster.id, 'onOff') as boolean;
      this.log.debug(`Switch ${load.address} TOGGLE command -> ${!currentState}`);
      await this.setSwitch(load.address, !currentState);
    });

    // Register device immediately - Matterbridge 3.3.8 expects this in onStart
    try {
      await this.registerDevice(device);
      this.log.info(`Registered switch device: ${load.name}`);
    } catch (err) {
      this.log.error(`Failed to register switch ${load.name}: ${err}`);
    }
    return device;
  }

  /**
   * Set dimmer level via serial
   */
  private async setDimmerLevel(address: string, level: number): Promise<void> {
    if (!this.connection?.isConnected) {
      this.log.warn(`Cannot set dimmer ${address}: not connected`);
      return;
    }

    try {
      await this.connection.setDimmer(address, level);
      // Immediately query to get the actual state
      await this.connection.queryLoad(address);
    } catch (err) {
      this.log.error(`Failed to set dimmer ${address}: ${err}`);
    }
  }

  /**
   * Set switch state via serial
   */
  private async setSwitch(address: string, on: boolean): Promise<void> {
    if (!this.connection?.isConnected) {
      this.log.warn(`Cannot set switch ${address}: not connected`);
      return;
    }

    try {
      await this.connection.setRelay(address, on);
      // Immediately query to get the actual state
      await this.connection.queryLoad(address);
    } catch (err) {
      this.log.error(`Failed to set switch ${address}: ${err}`);
    }
  }

  /**
   * Handle status updates from polling
   */
  private handleLoadStatus(status: LoadStatus): void {
    const device = this.devices.get(status.address);
    if (!device) {
      return;
    }

    const deviceType = this.deviceTypes.get(status.address);

    try {
      if (deviceType === 'dimmer') {
        // Update OnOff state
        const isOn = status.level > 0;
        device.setAttribute(OnOff.Cluster.id, 'onOff', isOn, this.log);

        // Update LevelControl ONLY when light is on
        // Matter spec requires currentLevel to be between minLevel (1) and maxLevel (254)
        // When off, we leave currentLevel at its last value
        if (isOn) {
          // Save the last known level for restoring on 'on' command
          this.lastDimmerLevels.set(status.address, status.level);
          // Convert 1-100 to 1-254 (Matter range)
          const matterLevel = Math.max(1, Math.round((status.level / 100) * 254));
          device.setAttribute(LevelControl.Cluster.id, 'currentLevel', matterLevel, this.log);
        }

        this.log.debug(`Dimmer ${status.address} status: ${status.level}% (on=${isOn})`);
      } else if (deviceType === 'switch') {
        // Update OnOff state
        const isOn = status.level > 0;
        device.setAttribute(OnOff.Cluster.id, 'onOff', isOn, this.log);

        this.log.debug(`Switch ${status.address} status: ${isOn ? 'ON' : 'OFF'}`);
      }
    } catch (err) {
      // Silently ignore errors when device is not yet active
      this.log.debug(`Status update skipped for ${status.address}: device not ready`);
    }
  }

  override async onConfigure(): Promise<void> {
    this.log.info('Configuring Litetouch platform');

    // Start polling after Matter server is ready
    if (this.connection?.isConnected) {
      this.connection.startPolling();
      this.log.info('Polling started');
    }
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`Shutting down Litetouch platform${reason ? ` (${reason})` : ''}`);

    // Clear any pending on timers
    for (const timer of this.pendingOnTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingOnTimers.clear();

    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }

    this.devices.clear();
    this.deviceTypes.clear();
  }
}
