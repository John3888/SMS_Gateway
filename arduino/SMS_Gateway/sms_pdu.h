#pragma once
#include <string>
#include <cstdint>

namespace sms {
inline void hexByte(std::string &out, uint8_t value) {
    const char *digits = "0123456789ABCDEF";
    out += digits[value >> 4]; out += digits[value & 15];
}
inline bool validPhone(const std::string &s) {
    if (s.size() < 3 || s.size() > 16 || s[0] != '+' || s[1] == '0') return false;
    for (size_t i = 1; i < s.size(); ++i) if (s[i] < '0' || s[i] > '9') return false;
    return true;
}
// A single UCS-2 SMS: 70 BMP characters. Reject malformed UTF-8, emoji,
// embedded NUL, and surrogate code points instead of silently corrupting text.
inline bool encodeText(const std::string &text, std::string &hex, std::string &error) {
    hex.clear(); error.clear();
    size_t count = 0;
    for (size_t i = 0; i < text.size();) {
        uint8_t c = static_cast<uint8_t>(text[i++]);
        uint32_t cp = 0; unsigned extra = 0; uint32_t minimum = 0;
        if (c < 0x80) cp = c;
        else if (c >= 0xC2 && c <= 0xDF) { cp = c & 31; extra = 1; minimum = 0x80; }
        else if (c >= 0xE0 && c <= 0xEF) { cp = c & 15; extra = 2; minimum = 0x800; }
        else { error = "Use UTF-8 BMP text; emoji are not supported"; return false; }
        if (i + extra > text.size()) { error = "Invalid UTF-8"; return false; }
        while (extra--) {
            uint8_t next = static_cast<uint8_t>(text[i++]);
            if ((next & 0xC0) != 0x80) { error = "Invalid UTF-8"; return false; }
            cp = (cp << 6) | (next & 63);
        }
        if (cp < minimum || cp == 0 || (cp >= 0xD800 && cp <= 0xDFFF)) {
            error = "Invalid UCS-2 character"; return false;
        }
        if (++count > 70) { error = "Maximum 70 characters per SMS"; return false; }
        hexByte(hex, cp >> 8); hexByte(hex, cp & 255);
    }
    if (!count) { error = "Message must not be empty"; return false; }
    return true;
}
inline std::string makePdu(const std::string &phone, const std::string &bodyHex) {
    // SMSC from SIM; SMS-SUBMIT, no delivery report, no validity period.
    std::string pdu = "000100";
    hexByte(pdu, phone.size() - 1); pdu += "91";
    for (size_t i = 1; i < phone.size(); i += 2) {
        pdu += (i + 1 < phone.size() ? phone[i + 1] : 'F'); pdu += phone[i];
    }
    pdu += "0008"; // PID 0, UCS-2 DCS
    hexByte(pdu, bodyHex.size() / 2); pdu += bodyHex;
    return pdu;
}
} // namespace sms
