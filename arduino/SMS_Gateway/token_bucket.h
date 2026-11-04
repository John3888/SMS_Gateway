#pragma once
#include <cstdint>
#include <cmath>

class TokenBucket {
    double tokens_;
    uint32_t last_;
    const double perMinute_, capacity_;
public:
    TokenBucket(double perMinute, double capacity, uint32_t start = 0)
        : tokens_(capacity), last_(start), perMinute_(perMinute), capacity_(capacity) {}
    bool take(uint32_t now, unsigned &retrySeconds) {
        // Unsigned subtraction also handles millis() wrapping around.
        tokens_ += static_cast<uint32_t>(now - last_) * perMinute_ / 60000.0;
        if (tokens_ > capacity_) tokens_ = capacity_;
        last_ = now;
        if (tokens_ < 1) { retrySeconds = static_cast<unsigned>(std::ceil((1 - tokens_) * 60.0 / perMinute_)); return false; }
        tokens_ -= 1; retrySeconds = 0; return true;
    }
};
