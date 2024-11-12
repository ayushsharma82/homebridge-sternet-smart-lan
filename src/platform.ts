import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { CCTDownlighter } from './CCTDownlighterAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Interface for the device configuration
 */
interface DeviceConfig {
  name: string;
  device_type: 'cct_downlighter';
  ip: string;
  restore_state: boolean;
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class SternetSmartHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    // Get devices from config
    const devices = this.validateConfig();
    
    if (!devices) {
      this.log.error('No valid devices found in config');
      return;
    }

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devices) {
      // generate a unique id for the accessory using the IP address
      // this ensures the same device keeps the same UUID even if the name changes
      const uuid = this.api.hap.uuid.generate(device.ip);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // update the accessory.context
        existingAccessory.context.device = {
          name: device.name,
          type: device.device_type,
          ip: device.ip,
          restore_state: device.restore_state,
        };
        this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        new CCTDownlighter(this, existingAccessory);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device object in the `accessory.context`
        accessory.context.device = {
          name: device.name,
          type: device.device_type,
          ip: device.ip,
        };

        // create the accessory handler
        new CCTDownlighter(this, accessory);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    // remove accessories that are no longer configured
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Validate the config and return an array of device configurations
   */
  private validateConfig(): DeviceConfig[] | null {
    // Check if config exists
    if (!this.config) {
      this.log.error('No configuration found');
      return null;
    }

    // For multiple device configurations
    if (Array.isArray(this.config.devices)) {
      const validDevices = this.config.devices.filter(device => {
        if (!device.ip || !device.device_type || device.device_type !== 'cct_downlighter') {
          this.log.error('Invalid device configuration:', device);
          return false;
        }
        return true;
      });

      if (validDevices.length === 0) {
        this.log.error('No valid devices found in config');
        return null;
      }

      return validDevices as DeviceConfig[];
    }

    this.log.error('Invalid configuration format');
    return null;
  }
}