#pragma once
#include <stdint.h>

// Copy to gateway_config.h. These are EXAMPLE pins, not a board-specific pinout.
constexpr char WIFI_SSID[] = "YOUR_WIFI_NAME";
constexpr char WIFI_PASSWORD[] = "YOUR_WIFI_PASSWORD";
// Use a random secret of at least 32 characters; keep it on your app's backend.
constexpr char API_KEY[] = "REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS";
constexpr char HOSTNAME[] = "sms-gateway";
constexpr int HTTP_PORT = 80;
constexpr int MODEM_RX_PIN = 16; // ESP RX <- modem TX (check logic voltage)
constexpr int MODEM_TX_PIN = 17; // ESP TX -> modem RX (check logic voltage)
constexpr unsigned long MODEM_BAUD = 115200;
// -1 means manually power the modem / board handles power.
constexpr int MODEM_POWER_ENABLE_PIN = -1;
constexpr int MODEM_POWER_ENABLE_LEVEL = 1;
constexpr int MODEM_PWRKEY_PIN = -1;
// For a breakout with a power-key transistor these levels may be inverted.
constexpr int MODEM_PWRKEY_ACTIVE_LEVEL = 0;
constexpr unsigned long MODEM_PWRKEY_PULSE_MS = 1000;
constexpr unsigned long MODEM_BOOT_MS = 10000;
constexpr unsigned long MIN_SMS_INTERVAL_MS = 5000;
// LAN-only mode's new-message allowance; repeated retained requests are free.
constexpr unsigned LAN_SMS_PER_MINUTE = 10;
constexpr unsigned LAN_SMS_BURST = 5;

// Optional public relay: only the ESP32 + Wi-Fi/router need to stay on locally.
// Deploy node-backend first (cloud-relay is an optional Cloudflare alternative).
// This still uses Wi-Fi for Internet.
constexpr bool CLOUD_ENABLED = false;
// Host only, without wss:// or a trailing slash. TLS is always enabled.
constexpr char CLOUD_HOST[] = "gateway.your-domain.com";
constexpr uint16_t CLOUD_PORT = 443;
constexpr char CLOUD_WS_PATH[] = "/device/ws";
// Different from the application's key and the LAN API_KEY.
constexpr char CLOUD_DEVICE_KEY[] = "REPLACE_WITH_ANOTHER_RANDOM_SECRET_AT_LEAST_32_CHARACTERS";
constexpr unsigned long CLOUD_RECONNECT_MS = 5000;
// PEM root CA which validates your deployed relay's HTTPS certificate chain.
// Supply the correct CA for your hostname; never replace validation with setInsecure().
constexpr char CLOUD_ROOT_CA[] = R"PEM(
)PEM";
