import WebSocket from 'ws';
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SternetSmartHomebridgePlatform } from './platform.js';

// Add the helper functions at the top of the file
const lerp = (min: number, max: number, n: number) => (1 - n) * min + n * max;

const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));

const invlerp = (min: number, max: number, n: number) =>
  clamp((n - min) / (max - min));

const interpolate = (inputRange: number[], outputRange: number[], n: number) =>
  lerp(
    outputRange[0],
    outputRange[1],
    invlerp(inputRange[0], inputRange[1], n),
  );

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

/**
 * CCT Downlighter Platform Accessory
 * Implements a color temperature adjustable downlighter with brightness control
 * Communicates with the physical device via WebSocket using direct hex values
 */
export class CCTDownlighter {
  private service: Service;
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private statusCheckInterval: NodeJS.Timeout | null = null;
  private readonly RECONNECT_INTERVAL = 5000; // 5 seconds
  private readonly STATUS_CHECK_INTERVAL = 3000; // 3 seconds
  private readonly MESSAGE_TIMEOUT = 5000; // 5 seconds
  private isOnline = false;
  private lastStatus: DeviceStatus | null = null;

  private states = {
    On: false,
    Brightness: 100,
    ColorTemperature: 300,
  };

  constructor(
    private readonly platform: SternetSmartHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
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
  }

  /**
   * Update accessory information based on device status
   */
  private updateAccessoryInfo(status: DeviceStatus) {
    const accessoryInfo = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    
    // Format firmware version as major.minor.patch
    const firmwareString = status.firmwareVersion.toString().padStart(7, '0');
    const major = parseInt(firmwareString.slice(0, 1));
    const minor = parseInt(firmwareString.slice(1, 4));
    const patch = parseInt(firmwareString.slice(4));
    const formattedFirmware = `${major}.${minor}.${patch}`;

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
    if (currentFirmware !== formattedFirmware) {
      accessoryInfo.setCharacteristic(this.platform.Characteristic.FirmwareRevision, formattedFirmware);
    }

    // Update name if hostname has changed
    const currentName = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
    if (currentName !== status.hostname) {
      this.service.updateCharacteristic(this.platform.Characteristic.Name, status.hostname);
    }

    this.lastStatus = status;
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
    
    // Convert to hex
    let coolHexValue = coolValue.toString(16);
    if (coolHexValue.length === 1) {
      coolHexValue = '0' + coolHexValue;
    }
    
    let warmHexValue = warmValue.toString(16);
    if (warmHexValue.length === 1) {
      warmHexValue = '0' + warmHexValue;
    }
    
    // Return the final hex string with padded zeros
    return '#' + coolHexValue + warmHexValue + '00';
  }

  /**
   * Send a message to the device with timeout and response handling
   */
  private async sendMessage(message: string): Promise<DeviceStatus | Record<string, never>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      // Set up timeout
      const timeoutId = setTimeout(() => {
        reject(new Error('Message timeout'));
      }, this.MESSAGE_TIMEOUT);

      // Set up one-time message handler
      const messageHandler = (data: WebSocket.Data) => {
        clearTimeout(timeoutId);
        this.ws!.removeListener('message', messageHandler);
        try {
          const response = JSON.parse(data.toString());
          // Validate if it's a status response by checking for required fields
          if ('hostname' in response && 'mac' in response && 'firmwareVersion' in response) {
            resolve(response as DeviceStatus);
          } else {
            // For hex color commands, we expect an empty object response
            resolve(response as Record<string, never>);
          }
        } catch (error) {
          reject(new Error('Invalid response format'));
        }
      };

      // Listen for the response
      this.ws.once('message', messageHandler);

      // Send the message
      try {
        this.ws.send(message);
      } catch (error) {
        clearTimeout(timeoutId);
        this.ws!.removeListener('message', messageHandler);
        reject(error);
      }
    });
  }
  
  /**
   * Check device status
   */
  private async checkStatus() {
    try {
      const status = await this.sendMessage(JSON.stringify({ cmd: 'STATUS' })) as DeviceStatus;
      
      // Update accessory information with status data
      this.updateAccessoryInfo(status);
      
      if (!this.isOnline) {
        this.isOnline = true;
        this.platform.log.info('Device is online:', status.hostname);
        // Update the connected state
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.states.On);
      }
    } catch (error) {
      if (this.isOnline) {
        this.isOnline = false;
        this.platform.log.warn('Device is offline:', this.accessory.displayName);
        // Optionally update characteristics to show device is unreachable
        this.service.updateCharacteristic(this.platform.Characteristic.On, new Error('Device offline'));
      }
    }
  }

  /**
   * Send the current state to the device as a hex value
   */
  private async sendState() {
    const hexValue = this.calculateHexValue();
    try {
      await this.sendMessage(hexValue);
      this.platform.log.debug('Sent hex value:', hexValue);
    } catch (error) {
      this.platform.log.error('Failed to send state:', error);
      throw error;
    }
  }

  /**
   * Initialize and manage WebSocket connection
   */
  private connectWebSocket() {
    const deviceIP = this.accessory.context.device.ip;
    const wsUrl = `ws://${deviceIP}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.platform.log.info('WebSocket connected to:', wsUrl);
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        // Start status checking
        if (this.statusCheckInterval) {
          clearInterval(this.statusCheckInterval);
        }
        this.statusCheckInterval = setInterval(() => {
          this.checkStatus().catch(error => {
            this.platform.log.debug('Status check failed:', error);
          });
        }, this.STATUS_CHECK_INTERVAL);

        // Send initial state
        this.sendState().catch(error => {
          this.platform.log.error('Failed to send initial state:', error);
        });
      });

      this.ws.on('close', () => {
        this.platform.log.warn('WebSocket connection closed');
        this.isOnline = false;
        if (this.statusCheckInterval) {
          clearInterval(this.statusCheckInterval);
          this.statusCheckInterval = null;
        }
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        this.platform.log.error('WebSocket error:', error);
        this.isOnline = false;
        if (this.statusCheckInterval) {
          clearInterval(this.statusCheckInterval);
          this.statusCheckInterval = null;
        }
        this.scheduleReconnect();
      });

    } catch (error) {
      this.platform.log.error('Failed to create WebSocket connection:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule WebSocket reconnection
   */
  private scheduleReconnect() {
    if (!this.reconnectTimeout) {
      this.reconnectTimeout = setTimeout(() => {
        this.platform.log.info('Attempting to reconnect WebSocket...');
        this.connectWebSocket();
      }, this.RECONNECT_INTERVAL);
    }
  }

  /**
   * Handle "SET" requests for the On/Off characteristic
   */
  async setOn(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new Error('Device offline');
    }
    this.states.On = value as boolean;
    await this.sendState();
    this.platform.log.debug('Set Characteristic On ->', value);
  }

  /**
   * Handle "GET" requests for the On/Off characteristic
   */
  async getOn(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new Error('Device offline');
    }
    return this.states.On;
  }

  /**
   * Handle "SET" requests for the Brightness characteristic
   */
  async setBrightness(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new Error('Device offline');
    }
    this.states.Brightness = value as number;
    await this.sendState();
    this.platform.log.debug('Set Characteristic Brightness -> ', value);
  }

  /**
   * Handle "GET" requests for the Brightness characteristic
   */
  async getBrightness(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new Error('Device offline');
    }
    return this.states.Brightness;
  }

  /**
   * Handle "SET" requests for the Color Temperature characteristic
   */
  async setColorTemperature(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new Error('Device offline');
    }
    this.states.ColorTemperature = value as number;
    await this.sendState();
    this.platform.log.debug('Set Characteristic Color Temperature -> ', value);
  }

  /**
   * Handle "GET" requests for the Color Temperature characteristic
   */
  async getColorTemperature(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new Error('Device offline');
    }
    return this.states.ColorTemperature;
  }

  /**
   * Cleanup method to be called when the accessory is removed
   */
  destroy() {
    if (this.ws) {
      this.ws.close();
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }
  }
}