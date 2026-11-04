#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <time.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include "sms_pdu.h"
#include "token_bucket.h"
#if __has_include("gateway_config.h")
#include "gateway_config.h"
#else
#include "gateway_config.example.h"
#endif

WebServer server(HTTP_PORT);
HardwareSerial modem(1);
SemaphoreHandle_t stateMutex;
QueueHandle_t pending;
TokenBucket localBudget(LAN_SMS_PER_MINUTE, LAN_SMS_BURST);
constexpr int JOB_COUNT = 16;
enum class State { Empty, Queued, Sending, Submitted, Failed, Unknown };
struct Job {
    String id, phone, message, error;
    State state = State::Empty;
    int reference = -1;
    uint32_t sequence = 0;
};
Job jobs[JOB_COUNT];
uint32_t nextSequence = 0;
bool modemReady = false;
String modemStatus = "starting";
int signalRssi = 99;
bool submissionUncertain = false; // quarantine UART after an ambiguous submission
String bootId;
bool cloudConnected = false, cloudWorkWanted = false;

struct Lock {
    Lock() { xSemaphoreTake(stateMutex, portMAX_DELAY); }
    ~Lock() { xSemaphoreGive(stateMutex); }
};
const char *stateName(State s) {
    switch (s) {
        case State::Queued: return "queued";
        case State::Sending: return "sending";
        case State::Submitted: return "submitted";
        case State::Failed: return "failed";
        case State::Unknown: return "unknown";
        default: return "empty";
    }
}
void jsonResponse(int code, const JsonDocument &doc) {
    String output; serializeJson(doc, output);
    server.sendHeader("Cache-Control", "no-store");
    server.send(code, "application/json", output);
}
void errorResponse(int code, const char *reason) {
    JsonDocument doc; doc["error"] = reason; jsonResponse(code, doc);
}
bool authorized() {
    String expected = String("Bearer ") + API_KEY;
    String received = server.header("Authorization");
    unsigned difference = received.length() ^ expected.length();
    for (size_t i = 0; i < expected.length(); ++i)
        difference |= static_cast<unsigned char>(expected[i]) ^
                      static_cast<unsigned char>(i < received.length() ? received[i] : 0);
    if (difference) { errorResponse(401, "Invalid or missing bearer token"); return false; }
    return true;
}
void jobResponse(int code, const Job &job) {
    JsonDocument doc;
    doc["id"] = job.id; doc["status"] = stateName(job.state);
    doc["status_url"] = String("/api/v1/sms/") + job.id;
    if (job.reference >= 0) doc["modem_reference"] = job.reference;
    if (job.error.length()) doc["error"] = job.error;
    jsonResponse(code, doc);
}
bool validId(const String &id) {
    if (!id.length() || id.length() > 64) return false;
    for (char c : id) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
    return true;
}
void postSms() {
    if (!authorized()) return;
    if (CLOUD_ENABLED) { errorResponse(403, "Use the hosted SMS API in WebSocket mode so application quotas apply"); return; }
    String contentType = server.header("Content-Type");
    contentType.toLowerCase();
    if (contentType != "application/json" && !contentType.startsWith("application/json;")) {
        errorResponse(415, "Content-Type must be application/json"); return;
    }
    String raw = server.arg("plain");
    if (raw.length() > 1024) { errorResponse(413, "JSON body exceeds 1024 bytes"); return; }
    JsonDocument doc;
    if (deserializeJson(doc, raw) || !doc.is<JsonObject>()) {
        errorResponse(400, "Invalid JSON object"); return;
    }
    if (!doc["phone"].is<String>() || !doc["message"].is<String>() ||
        !doc["idempotency_key"].is<String>()) {
        errorResponse(400, "phone, message and idempotency_key must be strings"); return;
    }
    String phone = doc["phone"].as<String>(), message = doc["message"].as<String>();
    String id = doc["idempotency_key"].as<String>();
    std::string encoded, why;
    if (!sms::validPhone(std::string(phone.c_str(), phone.length()))) {
        errorResponse(422, "Use international phone format: + and 2-15 digits, no leading zero"); return;
    }
    if (!validId(id)) { errorResponse(422, "idempotency_key: 1-64 letters, digits, - or _"); return; }
    if (!sms::encodeText(std::string(message.c_str(), message.length()), encoded, why)) {
        errorResponse(422, why.c_str()); return;
    }
    Job response;
    const char *failure = nullptr;
    unsigned retrySeconds = 0;
    int code = [&]() -> int {
        Lock guard;
        for (const Job &job : jobs) {
            if (job.state != State::Empty && job.id == id) {
                if (job.phone != phone || job.message != message) {
                    failure = "Idempotency key already used with different content"; return 409;
                }
                response = job; return 200;
            }
        }
        if (!modemReady) { failure = "Modem unavailable; check /api/v1/health"; return 503; }
        int slot = -1;
        for (int i = 0; i < JOB_COUNT; ++i) {
            if (jobs[i].state == State::Empty) { slot = i; break; }
            if (jobs[i].state != State::Queued && jobs[i].state != State::Sending &&
                (slot < 0 || jobs[i].sequence < jobs[slot].sequence)) slot = i;
        }
        if (slot < 0) { failure = "Queue full; try later"; retrySeconds = 5; return 429; }
        if (!localBudget.take(millis(), retrySeconds)) {
            failure = "LAN SMS rate limit exceeded"; return 429;
        }
        Job previous = jobs[slot];
        Job &job = jobs[slot];
        job = Job{}; job.id = id; job.phone = phone; job.message = message;
        job.state = State::Queued; job.sequence = ++nextSequence;
        if (xQueueSend(pending, &slot, 0) != pdTRUE) {
            job = previous; failure = "Queue full; try later"; retrySeconds = 5; return 429;
        }
        response = job;
        return 202;
    }();
    if (retrySeconds) server.sendHeader("Retry-After", String(retrySeconds));
    if (failure) errorResponse(code, failure); else jobResponse(code, response);
}

struct AtReply { bool ok = false; bool prompt = false; bool timedOut = false; String text; int reference = -1; };
// Only the modem task accesses the UART. Unsolicited lines cannot count as OK.
AtReply readReply(uint32_t timeout, bool wantPrompt = false) {
    AtReply result;
    String line;
    uint32_t start = millis();
    while (millis() - start < timeout) {
        while (modem.available()) {
            char c = modem.read();
            if (wantPrompt && c == '>') { result.prompt = true; return result; }
            if (c == '\r') continue;
            if (c != '\n') { if (line.length() < 256) line += c; continue; }
            line.trim();
            if (line.length()) {
                if (result.text.length() < 2048) result.text += line + "\n";
                if (line.startsWith("+CMGS:")) result.reference = line.substring(6).toInt();
                if (line == "OK") { result.ok = true; return result; }
                if (line == "ERROR" || line.startsWith("+CMS ERROR:") || line.startsWith("+CME ERROR:")) return result;
            }
            line = "";
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    result.timedOut = true; return result;
}
AtReply command(const String &cmd, uint32_t timeout = 3000) {
    while (modem.available()) modem.read();
    modem.print(cmd); modem.print('\r');
    return readReply(timeout);
}
void updateHealth(bool ready, const String &status, int rssi = 99) {
    Lock guard;
    if (ready && !modemReady) cloudWorkWanted = true;
    modemReady = ready; modemStatus = status; signalRssi = rssi;
}
bool registered(const String &commandName, const char *prefix) {
    AtReply reply = command(commandName);
    int start = reply.text.indexOf(prefix);
    if (!reply.ok || start < 0) return false;
    int comma = reply.text.indexOf(',', start);
    if (comma < 0) return false;
    int state = reply.text.substring(comma + 1).toInt();
    return state == 1 || state == 5;
}
bool prepareModem() {
    if (!command("AT").ok) { updateHealth(false, "no_modem_response"); return false; }
    if (!command("ATE0").ok || !command("AT+CMEE=2").ok ||
        !command("AT+IFC=0,0").ok) { updateHealth(false, "modem_setup_failed"); return false; }
    auto sim = command("AT+CPIN?");
    if (!sim.ok || sim.text.indexOf("+CPIN: READY") < 0) {
        updateHealth(false, "sim_missing_or_pin_locked"); return false;
    }
    // Some networks use EPS registration, others circuit-switched registration.
    if (!registered("AT+CEREG?", "+CEREG:") && !registered("AT+CREG?", "+CREG:")) {
        updateHealth(false, "waiting_for_network"); return false;
    }
    if (!command("AT+CMGF=0").ok) { updateHealth(false, "pdu_mode_failed"); return false; }
    auto csq = command("AT+CSQ");
    int at = csq.text.indexOf("+CSQ:");
    int rssi = at < 0 ? 99 : csq.text.substring(at + 5).toInt();
    updateHealth(true, "ready", rssi); return true;
}
Job submitSms(Job snapshot) {
    State outcome = State::Failed;
    String error;
    int reference = -1;
    if (submissionUncertain) error = "Modem quarantined after ambiguous send; inspect previous unknown job and reboot";
    else if (!prepareModem()) error = "Modem or network unavailable before submission";
    else {
        std::string bodyHex, why;
        sms::encodeText(std::string(snapshot.message.c_str(), snapshot.message.length()), bodyHex, why);
        std::string pdu = sms::makePdu(snapshot.phone.c_str(), bodyHex);
        while (modem.available()) modem.read();
        modem.print(String("AT+CMGS=") + static_cast<unsigned int>(pdu.size() / 2 - 1) + "\r");
        auto prompt = readReply(10000, true);
        if (!prompt.prompt) {
            // Escape any late input prompt before attempting any further AT commands.
            modem.write(0x1B); readReply(3000);
            error = "Modem did not accept SMS input";
            updateHealth(false, "sms_prompt_failed");
        } else {
            modem.print(pdu.c_str()); modem.write(0x1A);
            auto reply = readReply(120000);
            reference = reply.reference;
            if (reference >= 0) {
                // +CMGS is confirmation of submission, even if final OK was lost.
                outcome = State::Submitted;
            } else if (reply.timedOut) {
                outcome = State::Unknown;
                error = "Submission timed out; SMS may have been sent. Do not blindly retry";
            } else {
                error = reply.text.substring(0, 400); if (!error.length()) error = "SMS rejected by modem";
            }
            if (reply.timedOut) {
                submissionUncertain = true;
                updateHealth(false, "submission_uncertain_reboot_required");
            }
        }
    }
    snapshot.state = outcome; snapshot.error = error; snapshot.reference = reference;
    return snapshot;
}
void sendJob(int slot) {
    Job snapshot;
    { Lock guard; jobs[slot].state = State::Sending; snapshot = jobs[slot]; }
    Job result = submitSms(snapshot);
    { Lock guard; jobs[slot] = result; }
}

#include "cloud_transport.h"

void modemTask(void *) {
    if (CLOUD_ENABLED) {
        cloudStorageReady = cloudPrefs.begin("sms-relay", false);
        if (!cloudStorageReady) Serial.println("Cloud NVS unavailable; remote sending disabled.");
        if (cloudStorageReady) {
            String stored = cloudPrefs.getString("active", "");
            if (stored.length()) {
                JsonDocument recovery;
                bool invalid = deserializeJson(recovery, stored) != DeserializationError::Ok;
                String phase = recovery["phase"] | "";
                if (invalid || phase == "armed" || (phase != "claim" && phase != "done")) {
                    // Quarantine BEFORE ever exposing ready=true to LAN callers.
                    submissionUncertain = true;
                    updateHealth(false, "submission_uncertain_reboot_required");
                }
            }
        }
    }
    if (MODEM_POWER_ENABLE_PIN >= 0) {
        pinMode(MODEM_POWER_ENABLE_PIN, OUTPUT); digitalWrite(MODEM_POWER_ENABLE_PIN, MODEM_POWER_ENABLE_LEVEL);
    }
    modem.setRxBufferSize(2048);
    modem.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
    vTaskDelay(pdMS_TO_TICKS(1000));
    if (!command("AT").ok && MODEM_PWRKEY_PIN >= 0) {
        digitalWrite(MODEM_PWRKEY_PIN, !MODEM_PWRKEY_ACTIVE_LEVEL); pinMode(MODEM_PWRKEY_PIN, OUTPUT);
        digitalWrite(MODEM_PWRKEY_PIN, MODEM_PWRKEY_ACTIVE_LEVEL);
        vTaskDelay(pdMS_TO_TICKS(MODEM_PWRKEY_PULSE_MS));
        digitalWrite(MODEM_PWRKEY_PIN, !MODEM_PWRKEY_ACTIVE_LEVEL);
    }
    vTaskDelay(pdMS_TO_TICKS(MODEM_BOOT_MS));
    uint32_t checked = 0;
    uint32_t cloudChecked = 0;
    bool retryCloud = false;
    bool first = true;
    for (;;) {
        if (!submissionUncertain && (first || millis() - checked >= 15000)) {
            prepareModem(); checked = millis(); first = false;
        }
        int slot;
        if (xQueueReceive(pending, &slot, pdMS_TO_TICKS(100)) == pdTRUE) {
            sendJob(slot);
            vTaskDelay(pdMS_TO_TICKS(MIN_SMS_INTERVAL_MS));
        } else if (CLOUD_ENABLED) {
            bool wanted;
            { Lock guard; wanted = cloudWorkWanted; }
            // An idle push is handled immediately; only another send/recovery
            // attempt observes the cooldown. No periodic idle queue polling.
            if ((wanted || retryCloud) && (!retryCloud || millis() - cloudChecked >= max(MIN_SMS_INTERVAL_MS, 1000UL))) {
                { Lock guard; cloudWorkWanted = false; }
                retryCloud = processCloudWork(); cloudChecked = millis();
            }
        }
    }
}
void setup() {
    Serial.begin(115200);
    bootId = String(esp_random(), HEX) + String(esp_random(), HEX);
    if (strlen(API_KEY) < 32 || String(API_KEY).startsWith("REPLACE_") || String(WIFI_SSID) == "YOUR_WIFI_NAME") {
        Serial.println("Configure the sketch's gateway_config.h tab before running the gateway.");
        for (;;) delay(1000);
    }
    if (!LAN_SMS_PER_MINUTE || !LAN_SMS_BURST || MIN_SMS_INTERVAL_MS < 1000 || CLOUD_RECONNECT_MS < 1000) {
        Serial.println("Invalid rate/reconnect settings"); for (;;) delay(1000);
    }
    if (CLOUD_ENABLED && (!strlen(CLOUD_HOST) || String(CLOUD_HOST).indexOf('/') >= 0 ||
        strlen(CLOUD_DEVICE_KEY) < 32 || String(CLOUD_DEVICE_KEY).startsWith("REPLACE_") ||
        String(CLOUD_ROOT_CA).indexOf("-----BEGIN CERTIFICATE-----") < 0)) {
        Serial.println("Configure WebSocket host, device key and trusted root CA before enabling cloud mode.");
        for (;;) delay(1000);
    }
    stateMutex = xSemaphoreCreateMutex(); pending = xQueueCreate(JOB_COUNT, sizeof(int));
    if (!stateMutex || !pending) { Serial.println("Allocation failed"); for (;;) delay(1000); }
    if (CLOUD_ENABLED) {
        cloudRequests = xQueueCreate(1, sizeof(CloudRequest)); cloudReplies = xQueueCreate(2, sizeof(CloudReply));
        if (!cloudRequests || !cloudReplies || xTaskCreate(websocketTask, "websocket", 12288, nullptr, 1, nullptr) != pdPASS) {
            Serial.println("WebSocket task allocation failed"); for (;;) delay(1000);
        }
    }
    if (xTaskCreate(modemTask, "modem", 16384, nullptr, 1, nullptr) != pdPASS) {
        Serial.println("Modem task failed"); for (;;) delay(1000);
    }
    WiFi.mode(WIFI_STA); WiFi.setHostname(HOSTNAME); WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    if (CLOUD_ENABLED) configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
    const char *headers[] = {"Authorization", "Content-Type"}; server.collectHeaders(headers, 2);
    server.on("/api/v1/sms", HTTP_POST, postSms);
    server.on("/api/v1/health", HTTP_GET, [] {
        if (!authorized()) return;
        JsonDocument doc;
        { Lock guard; doc["ready"] = modemReady; doc["modem"] = modemStatus; doc["rssi"] = signalRssi; doc["cloud_connected"] = cloudConnected; }
        doc["ip"] = WiFi.localIP().toString(); doc["uptime_seconds"] = millis() / 1000;
        doc["boot_id"] = bootId;
        jsonResponse(200, doc);
    });
    server.onNotFound([] {
        if (!authorized()) return;
        const String prefix = "/api/v1/sms/";
        if (server.method() == HTTP_GET && server.uri().startsWith(prefix)) {
            String id = server.uri().substring(prefix.length()); Job result; bool found = false;
            { Lock guard; for (const Job &j : jobs) if (j.state != State::Empty && j.id == id) { result = j; found = true; break; } }
            if (found) jobResponse(200, result); else errorResponse(404, "Job not found or no longer retained");
        } else errorResponse(404, "Endpoint not found");
    });
    server.begin();
}
void loop() {
    static bool announced = false;
    static uint32_t lastReconnect = 0;
    if (WiFi.status() == WL_CONNECTED) {
        if (!announced) {
            Serial.printf("Gateway: http://%s:%d/api/v1/sms\n", WiFi.localIP().toString().c_str(), HTTP_PORT);
            if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", HTTP_PORT);
            announced = true;
        }
        server.handleClient();
    } else {
        if (announced) { MDNS.end(); announced = false; }
        if (millis() - lastReconnect >= 30000) { WiFi.reconnect(); lastReconnect = millis(); }
    }
    delay(2);
}
