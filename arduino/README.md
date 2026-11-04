# Open the gateway in Arduino IDE

Open **`SMS_Gateway/SMS_Gateway.ino`**. Keep the whole `SMS_Gateway` folder together. Arduino IDE opens the `.h` files as editable tabs; they are part of the sketch. Arduino sketches use C++, and this project uses Arduino's libraries and normal `setup()`/`loop()` entry points.

## Board and libraries

In Boards Manager install **esp32 by Espressif Systems**. The Arduino build is checked with the installed **3.3.11** package. If you need the board-package URL, use [Espressif's installation instructions](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html).

In Library Manager install these versions:

- **ArduinoJson** by Benoit Blanchon: **7.2.1**.
- **WebSockets** by Markus Sattler (Links2004): **2.6.1**. This is the WebSockets library, not ArduinoWebsockets.

WiFi, WebServer, Preferences, ESPmDNS and the ESP32 task libraries are included with the Espressif board package.

Select these Tools settings for the ESP32-S3 N16R8 module:

| Setting | Value |
| --- | --- |
| Board | ESP32S3 Dev Module |
| Flash Size | 16 MB (128 Mb) |
| Flash Mode | QIO, 80 MHz |
| PSRAM | OPI PSRAM |
| Partition Scheme | 16M Flash (3MB APP/9.9MB FATFS) |
| USB Mode | Hardware CDC and JTAG |
| USB CDC On Boot | Enabled |
| Erase All Flash Before Sketch Upload | Disabled |
| Upload Speed | 115200 initially; faster if reliable |

Native USB and USB-to-UART bridge boards can expose different ports. Select the actual board port. BOOT/RESET may be needed for the first upload. Pin mapping and modem UART voltage still need to match your particular breakout board.

**When upgrading an active gateway, keep its existing partition layout and preserve NVS.** The partition choice above is for a new Arduino setup. Settle existing in-flight jobs first before changing layouts; do not erase flash as a routine troubleshooting step. A new partition selection can affect stored data even when the flash size matches.

## Configuration

1. In the sketch folder, copy `gateway_config.example.h` to **`gateway_config.h`**. Reopen the sketch if the new tab does not appear.
2. Set Wi-Fi credentials, your local diagnostic `API_KEY`, modem RX/TX pins and any power options.
3. For the hosted WebSocket gateway set `CLOUD_ENABLED=true`, `CLOUD_HOST` (host only), `CLOUD_DEVICE_KEY`, and `CLOUD_ROOT_CA`. Follow the [Node backend setup](../node-backend/README.md) for hosting, device/application keys and TLS. The [Cloudflare backend](../cloud-relay/README.md) is an alternative; choose one backend.
4. Click **Verify**, then **Upload**, then open Serial Monitor at **115200 baud**.

The template has placeholders and will compile, but refuses to operate until configured. If `gateway_config.h` already exists, edit that tab rather than overwriting it with the example. Keep your real `gateway_config.h` private. All firmware and required helpers are in this sketch folder.

Verification: the cloud-enabled `.ino` sketch compiled using Arduino CLI 1.5.1 with ESP32 board package 3.3.11, 16 MB QIO flash, OPI PSRAM and the board settings above. This verifies compilation; physical modem wiring, SIM/carrier operation and deployed HTTPS credentials still need testing.

With the modem separately powered, planned signals are GPIO17 (ESP TX) to modem RX, GPIO16 (ESP RX) from modem TX, and shared GND. Check voltage compatibility first. If only these three signals are connected, power on the modem yourself or use its automatic power-on circuit; firmware cannot power-cycle it.

To integrate the supplied Express route and `{ number, message }` JSON, see [the controller integration](../integrations/express/README.md).
