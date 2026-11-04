import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

// Keep your existing router.post('/sms-send/', sendSMS). This replaces the
// unacknowledged Socket.IO broadcast with an authenticated durable submission.
export const sendSMS = async (req: Request, res: Response) => {
  const { number, message, idempotency_key, ttl_seconds } = req.body ?? {};
  if (typeof number !== 'string' || !number || typeof message !== 'string' || !message) {
    return res.status(400).json({ message: 'Number and message are required.' });
  }
  const headerKey = req.get('Idempotency-Key');
  if (headerKey && idempotency_key !== undefined && headerKey !== idempotency_key) {
    return res.status(409).json({ success: false, message: 'Idempotency-Key header and body key must match.' });
  }
  const key = headerKey ?? idempotency_key ?? randomUUID();
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
    return res.status(400).json({ success: false, message: 'Invalid idempotency key.' });
  }
  res.set('Idempotency-Key', key);
  const base = process.env.SMS_GATEWAY_URL?.replace(/\/+$/, '');
  const apiKey = process.env.SMS_GATEWAY_API_KEY;
  if (!base || !apiKey) {
    return res.status(503).json({ success: false, message: 'SMS gateway is not configured.', idempotency_key: key });
  }
  try {
    const response = await fetch(`${base}/sms-send/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ number, message, ...(ttl_seconds === undefined ? {} : { ttl_seconds }) }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) res.set('Retry-After', retryAfter);
    let result;
    try { result = await response.json(); }
    catch {
      return res.status(502).json({ success: false, message: 'Invalid gateway response; submission outcome is unconfirmed.', idempotency_key: key });
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return res.status(502).json({ success: false, message: 'Invalid gateway response; submission outcome is unconfirmed.', idempotency_key: key });
    }
    if (!response.ok) {
      return res.status(response.status).json({ success: false,
        message: result.message || result.error || 'Gateway rejected the request.', idempotency_key: key });
    }
    if (result.success !== true || typeof result.job?.id !== 'string') {
      return res.status(502).json({ success: false, message: 'Gateway did not confirm a queued job.', idempotency_key: key });
    }
    // HTTP 200 confirms acceptance by the gateway, not delivery to the handset.
    return res.status(200).json({
      success: true,
      message: 'SMS job sent to gateway.',
      data: { number, message },
      job: result.job,
    });
  } catch {
    // Do not log SMS contents, phone numbers or credentials. Do not blindly
    // repeat a POST with a new key after an ambiguous connection failure.
    return res.status(503).json({ success: false,
      message: 'Unable to confirm gateway submission. Retry with the same idempotency key.', idempotency_key: key });
  }
};
