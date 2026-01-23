# Matterbridge Litetouch 2000

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that exposes Litetouch 2000 lighting loads as Matter devices.

This allows you to control your Litetouch lighting system from any Matter-compatible ecosystem:
- Apple Home (HomeKit)
- Google Home
- Amazon Alexa
- Home Assistant
- Hubitat Elevation
- And more...

## Features

- **Dimmers**: Full brightness control with on/off and level adjustment
- **Switches**: On/off control for relay loads
- **Status Polling**: Automatically polls loads to detect changes from wall keypads
- **Priority Queue**: User commands are prioritized over polling for responsive control
- **Apple Home Optimized**: Includes workaround for Apple Home's command sequencing to prevent brightness flash when turning on dimmers

## Requirements

- Raspberry Pi (or similar Linux system) with Node.js 18+
- USB-to-serial adapter connected to your Litetouch CCU
- Litetouch 2000 with Standard or Compact CCU (not compatible with 5000LC)

## Hardware Setup

### Serial Cable

You need a serial cable between the USB-serial adapter and the Litetouch CCU. Use an RJ45-to-RS232 adapter with the following pinout:

| RJ45 Pin | RS232 Signal |
|----------|--------------|
| 2        | TX           |
| 3        | RX           |
| 5        | GND          |
| 7 & 8    | Bridge together on CCU side only |

Bridging pins 7 & 8 on the CCU side enables polling mode.

### Identify Serial Port

After connecting the USB-serial adapter, find the device path:

```bash
ls -la /dev/ttyUSB*
# or
ls -la /dev/serial/by-id/
```

## Installation

### 1. Install Matterbridge

If you haven't already, install Matterbridge:

```bash
sudo npm install -g matterbridge
```

### 2. Install This Plugin

**Option A: Matterbridge Web UI (Recommended)**

1. Open the Matterbridge web UI (default: http://localhost:8283)
2. Click the three-dot menu next to the plugin search box
3. Find `matterbridge-litetouch` in the list
4. Click Install

**Option B: Command Line**

```bash
sudo npm install -g matterbridge-litetouch
sudo matterbridge -add matterbridge-litetouch
```

### 3. Configure the Plugin

**Note:** The Matterbridge web UI does not support the array-of-objects format needed for load configuration. Edit the config file directly:

```bash
sudo nano /root/.matterbridge/matterbridge-litetouch.config.json
```

After editing, restart matterbridge:
```bash
sudo systemctl restart matterbridge
```

Configuration options:

- **Serial Port**: Path to your USB-serial device (e.g., `/dev/ttyUSB0`)
- **Baud Rate**: Usually 9600 (default)
- **Polling Interval**: Time between status polls in milliseconds (default: 2000)
- **Dimmers**: List of dimmer load addresses with friendly names
- **Switches**: List of relay load addresses with friendly names

### Example Configuration

```json
{
  "name": "Litetouch 2000",
  "serialPort": "/dev/ttyUSB0",
  "baudRate": 9600,
  "pollingInterval": 2000,
  "commandTimeout": 1000,
  "dimmers": [
    { "address": "01-1", "name": "Living Room Main" },
    { "address": "01-2", "name": "Living Room Accent" },
    { "address": "02-1", "name": "Kitchen" },
    { "address": "03-4", "name": "Master Bedroom" }
  ],
  "switches": [
    { "address": "05-1", "name": "Garage" },
    { "address": "05-2", "name": "Porch Light" }
  ],
  "debug": false
}
```

## Load Addressing

Litetouch loads are addressed as `MM-O` where:
- `MM` = Module number (1-99)
- `O` = Output number on that module (1-6 typically)

Example addresses: `01-1`, `03-4`, `10-6`

To find your load addresses, refer to your Litetouch programming documentation or use the Litetouch Designer software.

## Starting Matterbridge

```bash
matterbridge
```

For production use, set up Matterbridge as a systemd service:

```bash
sudo matterbridge -service install
sudo systemctl enable matterbridge
sudo systemctl start matterbridge
```

## Commissioning to Your Ecosystem

1. Start Matterbridge and wait for it to initialize
2. Open the Matterbridge web UI and note the QR code or pairing code
3. In your Matter controller app (Apple Home, Google Home, etc.):
   - Choose "Add Accessory" or "Set up device"
   - Scan the QR code or enter the pairing code
4. The Litetouch loads will appear as individual light/switch devices

### Hubitat-Specific Instructions

1. Go to **Devices** → **Add Device** → **Matter**
2. Use the Hubitat mobile app to scan the QR code
3. Devices will appear automatically in your device list

## Troubleshooting

### Serial Port Access

If you get permission errors, add your user to the dialout group:
```bash
sudo usermod -a -G dialout $USER
# Log out and back in for changes to take effect
```

### Debug Logging

Enable debug mode in the plugin configuration to see detailed serial communication logs.

### Common Issues

| Issue | Solution |
|-------|----------|
| "Serial port not found" | Check USB connection and port path |
| "Permission denied" | Add user to dialout group |
| "No response from CCU" | Verify cable pinout and baud rate |
| "Devices not updating" | Check that polling is running in logs |

## Protocol Reference

The Litetouch 2000 uses an ASCII protocol over RS-232:

- **Query load**: ` 18 MM-O` → Response: `R 18 MM-O LLL`
- **Set level**: ` 10 MM-O LLL`
  - For relays: `LLL` = `000` (off) or `001` (on)
  - For dimmers: `LLL` = `000`-`250`

Commands are terminated with carriage return (`\r`).

## Development

To build from source:

```bash
git clone https://github.com/signal15/matterbridge-litetouch.git
cd matterbridge-litetouch
npm install
npm run build
sudo npm install -g .
sudo matterbridge -add matterbridge-litetouch
```

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) - Free for personal and noncommercial use.

## Credits

Based on the original [Vera Litetouch plugin](https://github.com/signal15/vera-litetouch-2000) by signal15.
