import WebSocket from 'ws';
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SternetSmartHomebridgePlatform } from './platform.js';

/**
 * CCT Downlighter Platform Accessory
 * Implements a color temperature adjustable downlighter with brightness control
 * Communicates with the physical device via WebSocket using direct hex values
 */
export class CCTDownlighter {
  private service: Service;
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private readonly RECONNECT_INTERVAL = 5000; // 5 seconds

  /**
   * States to track the accessory characteristics
   */
  private states = {
    On: false,
    Brightness: 100,
    ColorTemperature: 300, // Default to warmest (2700K)
  };

  constructor(
    private readonly platform: SternetSmartHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'CCT Downlighter')
      .setCharacteristic(this.platform.Characteristic.Model, 'CCT-DL1')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'CCT-001');

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
        minValue: 140, // 7143K (Cool White)
        maxValue: 500, // 2000K (Warm White)
      })
      .onSet(this.setColorTemperature.bind(this))
      .onGet(this.getColorTemperature.bind(this));

    // Initialize WebSocket connection
    this.connectWebSocket();
  }

  /**
   * Calculate the hex value based on current state
   */
  private calculateHexValue(): string {
    // Return black if light is off
    if (!this.states.On) {
      return '#000000';
    }

    const temperatureInKelvin = Math.round(1000000 / this.states.ColorTemperature);
    
    // Calculate the ratio between warm and cool white based on color temperature
    const ratio = (temperatureInKelvin - 2700) / (7143 - 2700);
    
    // Calculate the LED values while respecting the combined brightness limit
    const totalBrightness = (this.states.Brightness / 100) * 100;
    
    // Calculate cool and warm values
    let coolValue = Math.round(ratio * totalBrightness);
    let warmValue = Math.round((1 - ratio) * totalBrightness);
    
    // Ensure combined brightness doesn't exceed 100
    if (coolValue + warmValue > 100) {
      const scale = 100 / (coolValue + warmValue);
      coolValue = Math.round(coolValue * scale);
      warmValue = Math.round(warmValue * scale);
    }
    
    // Convert to hex (max 64 in hex = 100 in decimal)
    const coolHex = Math.round((coolValue / 100) * 0x64).toString(16).padStart(2, '0').toUpperCase();
    const warmHex = Math.round((warmValue / 100) * 0x64).toString(16).padStart(2, '0').toUpperCase();
    
    // Create the final hex string
    return `#${coolHex}${warmHex}00`;
  }

  /**
   * Send the current state to the device as a hex value
   */
  private sendState() {
    const hexValue = this.calculateHexValue();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(hexValue);
      this.platform.log.debug('Sent hex value:', hexValue);
    } else {
      this.platform.log.warn('WebSocket not connected, cannot send hex value');
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
        // Send initial state
        this.sendState();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          // If the device sends back state updates, handle them here
          const hexValue = data.toString();
          this.platform.log.debug('Received hex value:', hexValue);
        } catch (error) {
          this.platform.log.error('Error handling WebSocket message:', error);
        }
      });

      this.ws.on('close', () => {
        this.platform.log.warn('WebSocket connection closed');
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        this.platform.log.error('WebSocket error:', error);
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
    this.states.On = value as boolean;
    this.sendState();
    this.platform.log.debug('Set Characteristic On ->', value);
  }

  /**
   * Handle "GET" requests for the On/Off characteristic
   */
  async getOn(): Promise<CharacteristicValue> {
    return this.states.On;
  }

  /**
   * Handle "SET" requests for the Brightness characteristic
   */
  async setBrightness(value: CharacteristicValue) {
    this.states.Brightness = value as number;
    this.sendState();
    this.platform.log.debug('Set Characteristic Brightness -> ', value);
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
    this.sendState();
    this.platform.log.debug('Set Characteristic Color Temperature -> ', value);
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
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
  }
}