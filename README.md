# homebridge-sternet-smart-lan

[![npm version](https://badge.fury.io/js/homebridge-sternet-smart-lan.svg)](https://badge.fury.io/js/homebridge-sternet-smart)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-yellow.svg)](https://opensource.org/licenses/Apache-2.0)

This is a Homebridge plugin for controlling Sternet Smart devices locally over LAN. It allows you to integrate your Sternet Smart devices with HomeKit, enabling control through the Home app and Siri.

## Features

- Local control of Sternet Smart devices over LAN connection
- No cloud dependency required
- Support for:
  - CCT Downlighters

## Prerequisites

- Node.js 18 or later
- Homebridge v1.8.0 or later
- Sternet Smart devices connected to your local network

## Installation

You can install this plugin through the Homebridge Config UI X or manually by running:

```bash
npm install -g homebridge-sternet-smart-lan
```

## Configuration

Add the following to your Homebridge `config.json` or use the Homebridge Config UI X to configure:

```json
{
    "platform": "SternetSmartHomebridgeLan",
    "devices": [
        {
            "name": "CCT Downlighter 1",
            "ip": "192.168.1.100",
            "type": "cct_downlighter"
        }
    ],
}
```

### Configuration Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `platform` | String | Required | Must be "SternetSmartPlatform" |
| `devices` | Array | Optional | Manual device configuration |

### Device Configuration Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | String | Required | Name of the device |
| `ip` | String | Required | IP address of the device |
| `type` | String | Required | Device type ("cct_downlighter") |

## Usage

1. Install the plugin
2. Configure your devices either manually or using auto-discovery
3. Restart Homebridge
4. Your Sternet Smart devices should appear in the Home app

## Troubleshooting

### Common Issues

1. **Device Not Found**
   - Ensure the device is connected to your local network
   - Verify the IP address is correct
   - Check if the device is responsive using ping

2. **Connection Failed**
   - Verify your network settings
   - Ensure the device firmware is up to date
   - Check if the device is accessible through the Sternet Smart app

3. **Device Not Responding**
   - Check your network connection
   - Verify the device's power supply
   - Restart the device

## Development

```bash
# Clone the repository
git clone https://github.com/ayushsharma82/homebridge-sternet-smart-lan.git

# Install dependencies
npm install

# Build the plugin
npm run build

# Link for development
npm link
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For bugs, feature requests, and discussions, please use the GitHub Issues page.

## Credits

This plugin is built and maintained by @ayushsharma82. Special thanks to the Homebridge community & Sternet Smart team for their support.

### Disclaimer

This plugin is not affiliated with, funded, or in any way associated with Sternet Smart. All product names, logos, and brands are property of their respective owners.
