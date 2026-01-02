/**
 * Matterbridge Plugin for Litetouch 2000 Lighting System
 *
 * Exposes Litetouch dimmers and switches as Matter devices that can be
 * controlled from any Matter-compatible ecosystem (Apple Home, Google Home,
 * Amazon Alexa, Home Assistant, Hubitat, etc.)
 */

import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { LitetouchPlatform } from './platform.js';

/**
 * Factory function to create the Litetouch platform
 * This is the entry point for Matterbridge
 */
export default function createPlatform(
  matterbridge: PlatformMatterbridge,
  log: AnsiLogger,
  config: PlatformConfig,
): MatterbridgeDynamicPlatform {
  return new LitetouchPlatform(matterbridge, log, config);
}

// Re-export the platform class for advanced usage
export { LitetouchPlatform } from './platform.js';
export { LitetouchConnection } from './litetouchConnection.js';
export { CommandQueue, CommandPriority } from './commandQueue.js';
