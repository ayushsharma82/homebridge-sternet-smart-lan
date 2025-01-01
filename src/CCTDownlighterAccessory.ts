import WebSocket from 'ws';
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SternetSmartHomebridgePlatform } from './platform.js';

// Add the helper functions at the top of the file
const lerp = (min: number, max: number, n: number) => (1 - n) * min + n * max;
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const invlerp = (min: number, max: number, n: number) => clamp((n - min) / (max - min));
const interpolate = (inputRange: number[], outputRange: number[], n: number) => 
  lerp(outputRange[0], outputRange[1], invlerp(inputRange[0], inputRange[1], n));

interface DeviceStatus {
  hostname: string;
  mac: string;
  WIFI_STATUS: string;
  PAIR_STATUS: boolean;
  MQTT_CONNECTED: boolean;
  firmwareVersion: number;
  WIFI_SSID: string;
  IP: string;
  RSSI: number;
  Free_Heap: number;
}

interface AccessoryState {
  On: boolean;
  Brightness: number;
  ColorTemperature: number;
}

/**
 * CCT Downlighter Platform Accessory
 * Implements a color temperature adjustable downlighter with brightness control
 * Communicates with the physical device via WebSocket using direct hex values
 * 
 * Features:
 * - Maintains state in HomeKit across restarts
 * - Optional state restoration to device on reconnect (controlled by restoreState setting)
 * - Automatic reconnection on connection loss
 * - Status monitoring via WebSocket
 */
export class CCTDownlighter {
  private service: Service;
  private ws: WebSocket | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private statusCheckInterval: NodeJS.Timeout | null = null;
  private readonly RECONNECT_INTERVAL = 15000;      // 15 seconds
  private readonly STATUS_CHECK_INTERVAL = 20000;  // 20 seconds
  private readonly CONNECTION_TIMEOUT = 30000;     // 30 seconds
  private isOnline = false;
  private lastStatus: DeviceStatus | null = null;
  private readonly restoreState: boolean;

  // States are always maintained for HomeKit, but only sent to device on reconnect if restoreState is true
  private states: AccessoryState = {
    On: false,
    Brightness: 100,
    ColorTemperature: 300,
  };

  constructor(
    private readonly platform: SternetSmartHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Get restore state preference from device config
    this.restoreState = accessory.context.device.restore_state ?? false;
    this.platform.log.debug(
      'Device restore state setting:',
      this.restoreState ? 'enabled' : 'disabled',
      '- Device will',
      this.restoreState ? 'restore' : 'not restore',
      'its last known state on reconnection',
    );

    // Always load cached state for HomeKit
    this.loadCachedState();

    // Get or create the Lightbulb service
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) 
      || this.accessory.addService(this.platform.Service.Lightbulb);

    // Set the service name
    this.service.setCharacteristic(
      this.platform.Characteristic.Name, 
      accessory.context.device.exampleDisplayName,
    );

    // Register handlers for On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Register handlers for Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    // Register handlers for Color Temperature Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .setProps({
        minValue: 143, // 7000K (Cool White)
        maxValue: 455, // 2200K (Warm White)
      })
      .onSet(this.setColorTemperature.bind(this))
      .onGet(this.getColorTemperature.bind(this));

    // Initialize WebSocket connection
    this.connectWebSocket();

    // Mark device as not responding initially
    this.updateNotResponding();
  }

  /**
   * Load cached state from accessory context
   * This state is always maintained for HomeKit regardless of restoreState setting
   */
  private loadCachedState() {
    const cachedState = this.accessory.context.state as AccessoryState | undefined;
    
    if (cachedState) {
      this.states = {
        On: cachedState.On,
        Brightness: cachedState.Brightness,
        ColorTemperature: cachedState.ColorTemperature,
      };
      this.platform.log.debug('Loaded cached state:', this.states);
    } else {
      // Initialize context with default values if no cached state exists
      this.accessory.context.state = this.states;
      this.platform.log.debug('No cached state found, using defaults:', this.states);
    }
  }

  /**
   * Save current state to accessory context
   * This is always done to maintain state in HomeKit
   */
  private saveState() {
    this.accessory.context.state = this.states;
  }

  /**
   * Update accessory information based on device status
   */
  private updateAccessoryInfo(status: DeviceStatus) {
    const accessoryInfo = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    const firmwareString = status.firmwareVersion.toString();
    
    // Only update characteristics if they've changed
    const currentManufacturer = accessoryInfo.getCharacteristic(this.platform.Characteristic.Manufacturer).value;
    if (currentManufacturer !== 'Sternet Smart') {
      accessoryInfo.setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sternet Smart');
    }

    const currentModel = accessoryInfo.getCharacteristic(this.platform.Characteristic.Model).value;
    if (currentModel !== 'CCT Downlighter') {
      accessoryInfo.setCharacteristic(this.platform.Characteristic.Model, 'CCT Downlighter');
    }

    const currentSerialNumber = accessoryInfo.getCharacteristic(this.platform.Characteristic.SerialNumber).value;
    if (currentSerialNumber !== status.mac) {
      accessoryInfo.setCharacteristic(this.platform.Characteristic.SerialNumber, status.mac);
    }

    const currentFirmware = accessoryInfo.getCharacteristic(this.platform.Characteristic.FirmwareRevision).value;
    if (currentFirmware !== firmwareString) {
      accessoryInfo.setCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareString);
    }

    // Update name if hostname has changed
    const currentName = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
    if (currentName !== status.hostname) {
      this.service.updateCharacteristic(this.platform.Characteristic.Name, status.hostname);
    }

    this.lastStatus = status;
  }

  /**
   * Mark device as not responding in HomeKit
   * Only needs to be set on the primary characteristic (On)
   */
  private updateNotResponding() {
    this.service.updateCharacteristic(
      this.platform.Characteristic.On,
      new Error('Device not responding'),
    );
  }

  /**
   * Calculate the hex value based on current state
   */
  private calculateHexValue(): string {
    // Return black if light is off
    if (!this.states.On) {
      return '#000000';
    }

    // Convert from mireds to Kelvin
    const temperatureInKelvin = Math.round(1000000 / this.states.ColorTemperature);
    
    // Use the interpolation function to calculate the color temperature
    // Map temperature range 2200-7000K to cool/warm ratio
    const saturation_sct = interpolate([2200, 7000], [0, 100], temperatureInKelvin);
    
    // Calculate cool and warm values based on brightness
    const coolValue = Math.floor(saturation_sct * (this.states.Brightness / 100));
    const warmValue = Math.floor((100 - saturation_sct) * (this.states.Brightness / 100));
    
    // Convert to hex with padding
    const coolHexValue = coolValue.toString(16).padStart(2, '0');
    const warmHexValue = warmValue.toString(16).padStart(2, '0');
    
    // Return the final hex string
    return '#' + coolHexValue + warmHexValue + '00';
  }

  /**
   * Send a message to the device if connection is open
   */
  private sendMessage(message: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  /**
   * Check device status
   */
  private checkStatus() {
    this.sendMessage(JSON.stringify({ cmd: 'STATUS' }));
  }

  /**
   * Send the current state to the device as a hex value
   */
  private sendState() {
    if (!this.isOnline) {
      return;
    }
    const hexValue = this.calculateHexValue();
    this.sendMessage(hexValue);
    this.platform.log.debug('Sent hex value:', hexValue);
  }

  /**
   * Initialize and manage WebSocket connection
   */
  private connectWebSocket() {
    const deviceIP = this.accessory.context.device.ip;
    const wsUrl = `ws://${deviceIP}/ws`;

    // Clear previous WS
    try {
      if (this.ws) {
        this.ws.close();
      }
    } catch (err) {
      this.platform.log.warn('Failed to close previous WebSocket connection:', err);
    }

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.platform.log.info('WebSocket connected to:', wsUrl);
        if (this.reconnectInterval) {
          clearInterval(this.reconnectInterval);
          this.reconnectInterval = null;
        }

        // Start status checking
        if (this.statusCheckInterval) {
          clearInterval(this.statusCheckInterval);
        }
        this.statusCheckInterval = setInterval(() => {
          this.checkStatus();
        }, this.STATUS_CHECK_INTERVAL);

        this.isOnline = true;

        // Restore state to device based on configuration
        if (this.restoreState) {
          this.platform.log.info('Restoring last known state to device:', this.states);
          this.sendState();
        } else {
          this.platform.log.debug('State restoration disabled - maintaining current device state');
        }
        
        // Always update HomeKit to show device is responding
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.states.On);

        // Create a connection timeout
        this.scheduleConnectionTimeout();
      });

      this.ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          // Validate if it's a status response by checking for required fields
          if ('hostname' in response && 'mac' in response && 'firmwareVersion' in response) {
            this.updateAccessoryInfo(response as DeviceStatus);
            if (!this.isOnline) {
              this.isOnline = true;
              this.platform.log.info('Device is online:', response.hostname);
              // Update HomeKit to show device is responding
              this.service.updateCharacteristic(this.platform.Characteristic.On, this.states.On);
            }
          }
          // Create a connection timeout based on last received message
          this.scheduleConnectionTimeout();
        } catch (error) {
          // Ignore parse errors for non-status messages
        }
      });

      this.ws.on('close', () => {
        this.platform.log.warn('WebSocket connection closed');
        this.handleDisconnection();
      });

      this.ws.on('error', (error) => {
        this.platform.log.debug('WebSocket error:', error);
        this.handleDisconnection();
      });

    } catch (error) {
      this.platform.log.debug('Failed to create WebSocket connection:', error);
      this.handleDisconnection();
    }
  }

  /**
   * Handle device disconnection
   */
  private handleDisconnection() {
    this.isOnline = false;
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
    this.updateNotResponding();
    this.scheduleReconnect();
  }

  /**
   * Schedule WebSocket reconnection
   */
  private scheduleReconnect() {
    if (this.reconnectInterval === null) {
      this.reconnectInterval = setInterval(() => {
        this.platform.log.debug('Attempting to reconnect WebSocket...');
        this.connectWebSocket();
      }, this.RECONNECT_INTERVAL);
    }
  }

  /**
   * Schedule connection timeout
   */
  private scheduleConnectionTimeout() {
    // Clear any existing connection timeout
    if (this.connectionTimeout !== null) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    this.connectionTimeout = setTimeout(() => {
      this.platform.log.warn('Connection timed out');
      this.ws?.terminate();
      this.handleDisconnection();
    }, this.CONNECTION_TIMEOUT);
  }

  /**
   * Handle "SET" requests for the On/Off characteristic
   */
  async setOn(value: CharacteristicValue) {
    this.states.On = value as boolean;
    this.saveState();
    if (this.isOnline) {
      this.sendState();
      this.platform.log.debug('Set Characteristic On ->', value);
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.states.On);
    }
  }

  /**
   * Handle "GET" requests for the On/Off characteristic
   * Primary characteristic that indicates device responsiveness
   */
  // async getOn(): Promise<CharacteristicValue> {
  //   return this.states.On;
  // }

  /**
   * Handle "SET" requests for the Brightness characteristic
   */
  async setBrightness(value: CharacteristicValue) {
    this.states.Brightness = value as number;
    this.saveState();
    if (this.isOnline) {
      this.sendState();
      this.platform.log.debug('Set Characteristic Brightness -> ', value);
    }
  }

  /**
   * Handle "GET" requests for the Brightness characteristic
   */
  async getBrightness(): Promise<CharacteristicValue> {
    return this.states.Brightness;
  }

  /**
   * Handle "SET" requests for the Color Temperature characteristic
   */
  async setColorTemperature(value: CharacteristicValue) {
    this.states.ColorTemperature = value as number;
    this.saveState();
    if (this.isOnline) {
      this.sendState();
      this.platform.log.debug('Set Characteristic Color Temperature -> ', value);
    }
  }

  /**
   * Handle "GET" requests for the Color Temperature characteristic
   */
  async getColorTemperature(): Promise<CharacteristicValue> {
    return this.states.ColorTemperature;
  }

  /**
   * Cleanup method to be called when the accessory is removed
   */
  destroy() {
    if (this.ws) {
      this.ws.close();
    }
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
    }
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }
  }
}
