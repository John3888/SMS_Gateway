#pragma once
#include <WebSocketsClient.h>
#include <Preferences.h>
#include <time.h>

// Only this task accesses the WebSocket. The modem task can block for an SMS
// without delaying heartbeats. Queues carry fixed-size POD buffers, never Strings.
struct CloudRequest { uint32_t id; char frame[1536]; };
struct CloudReply { uint32_t id; int status; char body[2048]; };
QueueHandle_t cloudRequests = nullptr, cloudReplies = nullptr;
Preferences cloudPrefs;
bool cloudStorageReady = false;

void wakeCloud() { Lock guard; cloudWorkWanted = true; }
void websocketTask(void *) {
    WebSocketsClient socket;
    String auth = String("Authorization: Bearer ") + CLOUD_DEVICE_KEY;
    socket.onEvent([&socket](WStype_t type, uint8_t *payload, size_t length) {
        if (type == WStype_CONNECTED) {
            { Lock guard; cloudConnected = true; cloudWorkWanted = true; }
        } else if (type == WStype_DISCONNECTED) {
            Lock guard; cloudConnected = false;
        } else if (type == WStype_TEXT) {
            JsonDocument frame;
            if (length > 2048 || deserializeJson(frame, payload, length)) { socket.disconnect(); return; }
            String kind = frame["type"] | "";
            if (kind == "available") wakeCloud();
            else if (kind == "reply" && frame["request_id"].is<uint32_t>() && frame["status"].is<int>()) {
                CloudReply reply{};
                reply.id = frame["request_id"].as<uint32_t>(); reply.status = frame["status"].as<int>();
                if (measureJson(frame["body"]) >= sizeof(reply.body)) { socket.disconnect(); return; }
                serializeJson(frame["body"], reply.body, sizeof(reply.body));
                xQueueSend(cloudReplies, &reply, 0);
            }
        } else if (type == WStype_BIN || type == WStype_FRAGMENT_TEXT_START ||
                   type == WStype_FRAGMENT_BIN_START || type == WStype_FRAGMENT || type == WStype_FRAGMENT_FIN) {
            socket.disconnect(); // Protocol uses bounded, unfragmented JSON text.
        }
    });
    while (WiFi.status() != WL_CONNECTED || time(nullptr) < 1700000000) vTaskDelay(pdMS_TO_TICKS(100));
    socket.beginSslWithCA(CLOUD_HOST, CLOUD_PORT, CLOUD_WS_PATH, CLOUD_ROOT_CA, "");
    socket.setExtraHeaders(auth.c_str());
    socket.setReconnectInterval(CLOUD_RECONNECT_MS);
    socket.enableHeartbeat(20000, 10000, 2);
    uint32_t lastStatus = 0;
    bool lastReady = false;
    for (;;) {
        if (WiFi.status() == WL_CONNECTED) socket.loop();
        else if (socket.isConnected()) socket.disconnect();
        CloudRequest request;
        if (xQueueReceive(cloudRequests, &request, 0) == pdTRUE && socket.isConnected())
            socket.sendTXT(request.frame);
        bool ready;
        { Lock guard; ready = modemReady; }
        if (socket.isConnected() && (millis() - lastStatus >= 30000 || lastReady != ready)) {
            JsonDocument doc; doc["type"] = "status"; doc["ready"] = ready;
            String data; serializeJson(doc, data); socket.sendTXT(data);
            lastStatus = millis(); lastReady = ready;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

// Synchronous request/reply for the modem worker, over the independently serviced
// WebSocket. A timeout is retried with the same durable claim token.
int cloudRpc(const char *type, const JsonDocument &body, JsonDocument &response) {
    { Lock guard; if (!cloudConnected) return -1; }
    static uint32_t sequence = 0;
    if (++sequence == 0) ++sequence;
    CloudReply reply;
    while (xQueueReceive(cloudReplies, &reply, 0) == pdTRUE) {}
    JsonDocument frame; frame["type"] = type; frame["request_id"] = sequence; frame["body"] = body;
    CloudRequest request{}; request.id = sequence;
    if (measureJson(frame) >= sizeof(request.frame)) return -1;
    serializeJson(frame, request.frame, sizeof(request.frame));
    if (xQueueSend(cloudRequests, &request, 0) != pdTRUE) return -1;
    uint32_t start = millis();
    while (millis() - start < 20000) {
        if (xQueueReceive(cloudReplies, &reply, pdMS_TO_TICKS(100)) == pdTRUE && reply.id == sequence) {
            if (deserializeJson(response, reply.body)) return -1;
            return reply.status;
        }
        { Lock guard; if (!cloudConnected) return -1; }
    }
    return -1;
}
bool saveCloudRecord(const JsonDocument &record) {
    String raw; serializeJson(record, raw);
    return cloudPrefs.putString("active", raw) == raw.length();
}
// true means retry recovery later; false means wait for a push/readiness event.
bool processCloudWork() {
    if (!cloudStorageReady) return false;
    { Lock guard; if (!cloudConnected) return false; }
    JsonDocument record;
    String stored = cloudPrefs.getString("active", "");
    if (stored.length()) {
        if (deserializeJson(record, stored) || !record["token"].is<String>() || !record["phase"].is<String>()) {
            Serial.println("Cloud NVS record invalid; inspect storage before recovery."); return false;
        }
    } else {
        String token;
        for (int i = 0; i < 8; ++i) { char hex[9]; snprintf(hex, sizeof(hex), "%08lx", static_cast<unsigned long>(esp_random())); token += hex; }
        record["token"] = token; record["phase"] = "claim";
        if (!saveCloudRecord(record)) return true;
    }
    String phase = record["phase"].as<String>();
    if (phase == "claim") {
        bool ready; { Lock guard; ready = modemReady; }
        if (!ready || submissionUncertain) return false;
        JsonDocument request, response; request["token"] = record["token"];
        int status = cloudRpc("claim", request, response);
        if (status == 204) return false;
        if (status != 200) return true;
        String remoteState = response["status"] | "";
        if (remoteState == "submitted" || remoteState == "failed" || remoteState == "unknown") {
            cloudPrefs.remove("active"); return true; // Clear then seek the next queued job.
        }
        Job job; job.id = response["id"] | ""; job.phone = response["phone"] | ""; job.message = response["message"] | "";
        std::string hex, why;
        if (!validId(job.id) || !sms::validPhone(std::string(job.phone.c_str(), job.phone.length())) ||
            !sms::encodeText(std::string(job.message.c_str(), job.message.length()), hex, why)) return false;
        request["id"] = job.id;
        JsonDocument startResponse;
        if (cloudRpc("start", request, startResponse) != 200) return true;
        record["id"] = job.id; record["phase"] = "armed";
        if (!saveCloudRecord(record)) return true;
        Job result = submitSms(job);
        record["phase"] = "done"; record["status"] = stateName(result.state);
        record["error"] = result.error; record["modem_reference"] = result.reference;
        if (!saveCloudRecord(record)) return true;
        phase = "done";
    }
    if (phase == "armed" || phase == "done") {
        JsonDocument result, response; result["token"] = record["token"]; result["id"] = record["id"];
        if (phase == "armed") {
            submissionUncertain = true; updateHealth(false, "submission_uncertain_reboot_required");
            result["status"] = "unknown";
            result["error"] = "Device restarted or storage failed during submission; SMS may have been sent";
        } else {
            result["status"] = record["status"]; result["error"] = record["error"];
            result["modem_reference"] = record["modem_reference"];
        }
        if (cloudRpc("result", result, response) == 200) cloudPrefs.remove("active");
        return true; // Retry a lost acknowledgement, or collect the next job.
    }
    return false;
}
