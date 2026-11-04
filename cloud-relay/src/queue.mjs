export class HttpError extends Error {
  constructor(status, message, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL = new Set(['submitted', 'failed', 'unknown', 'expired', 'cancelled']);
function limit(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(503, 'Invalid rate/queue configuration');
  return n;
}
export function publicJob(row, device = false) {
  const result = { id: row.id, idempotency_key: row.request_key, status: row.status,
    status_url: `/api/v1/sms/${row.id}`, created_at: row.created_at, expires_at: row.expires_at };
  if (row.modem_reference != null && row.modem_reference >= 0) result.modem_reference = row.modem_reference;
  if (row.error) result.error = row.error;
  if (device) { result.phone = row.phone; result.message = row.message; }
  return result;
}
function validate(data) {
  if (![data.phone, data.message, data.idempotency_key].every(x => typeof x === 'string')) throw new HttpError(400, 'phone, message and idempotency_key must be strings');
  if (!/^\+[1-9][0-9]{1,14}$/.test(data.phone) || !ID.test(data.idempotency_key)) throw new HttpError(422, 'Invalid phone or idempotency_key');
  const chars = [...data.message];
  if (!chars.length || chars.length > 70 || chars.some(c => !c.codePointAt(0) || c.codePointAt(0) > 0xffff || /^[\uD800-\uDFFF]$/.test(c)))
    throw new HttpError(422, 'Use 1-70 BMP characters; NUL and non-BMP emoji unsupported');
  const ttl = data.ttl_seconds ?? 3600;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new HttpError(422, 'ttl_seconds must be 60-86400');
  return ttl;
}
export class QueueStore {
  constructor(storage, config = {}, clock = () => Date.now()) {
    this.storage = storage; this.sql = storage.sql; this.clock = clock;
    this.maxPending = limit(config.MAX_PENDING, 100, 1, 10000);
    this.globalRate = limit(config.GLOBAL_SMS_PER_MINUTE, 12, 1, 1000);
    this.globalBurst = limit(config.GLOBAL_SMS_BURST, 10, 1, 1000);
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, request_key TEXT NOT NULL,
       phone TEXT NOT NULL, message TEXT NOT NULL, ttl_seconds INTEGER NOT NULL, status TEXT NOT NULL,
       claim_token TEXT UNIQUE, modem_reference INTEGER, error TEXT, created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(app_id,request_key))`,
      'CREATE INDEX IF NOT EXISTS job_schedule ON jobs(status,app_id,created_at)',
      'CREATE TABLE IF NOT EXISTS buckets (id TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS daily_usage (app_id TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(app_id,day))',
      'CREATE TABLE IF NOT EXISTS served (app_id TEXT PRIMARY KEY, at INTEGER NOT NULL)',
    ]) this.sql.exec(statement);
  }
  rows(sql, ...args) { return this.sql.exec(sql, ...args).toArray(); }
  one(sql, ...args) { return this.rows(sql, ...args)[0]; }
  expire() { this.sql.exec("UPDATE jobs SET status='expired',updated_at=? WHERE status='queued' AND expires_at<=?", this.clock(), this.clock()); }
  budget(id, rate, burst) {
    const now = this.clock(), existing = this.one('SELECT * FROM buckets WHERE id=?', id);
    const tokens = existing ? Math.min(burst, existing.tokens + Math.max(0, now - existing.updated_at) * rate / 60000) : burst;
    if (tokens < 1) throw new HttpError(429, 'Rate limit exceeded', Math.max(1, Math.ceil((1 - tokens) * 60 / rate)));
    this.sql.exec('INSERT INTO buckets VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens,updated_at=excluded.updated_at', id, tokens - 1, now);
  }
  requestBudget(app) { this.budget(`requests:${app}`, 120, 30); }
  deviceBudget() { this.budget('device', 240, 30); }
  enqueue(app, data) {
    const ttl = validate(data); this.expire();
    const existing = this.one('SELECT * FROM jobs WHERE app_id=? AND request_key=?', app.id, data.idempotency_key);
    if (existing) {
      if (existing.phone !== data.phone || existing.message !== data.message || existing.ttl_seconds !== ttl)
        throw new HttpError(409, 'Idempotency key already used with different content or TTL');
      return { job: existing, created: false };
    }
    const rate = limit(app.rate_per_minute, 10, 1, 1000), burst = limit(app.burst, 5, 1, 1000);
    const maxPending = limit(app.max_pending, Math.min(20, this.maxPending), 1, this.maxPending), daily = limit(app.daily_limit, 200, 1, 100000);
    return this.storage.transactionSync(() => {
      const active = "status IN ('queued','claimed','sending')";
      if (this.one(`SELECT COUNT(*) AS n FROM jobs WHERE ${active}`).n >= this.maxPending ||
          this.one(`SELECT COUNT(*) AS n FROM jobs WHERE app_id=? AND ${active}`, app.id).n >= maxPending)
        throw new HttpError(429, 'Queue capacity reached', 5);
      const now = this.clock(), day = new Date(now).toISOString().slice(0, 10);
      if ((this.one('SELECT used FROM daily_usage WHERE app_id=? AND day=?', app.id, day)?.used || 0) >= daily)
        throw new HttpError(429, 'Daily SMS quota reached', Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000 - now) / 1000));
      this.budget(`sms:${app.id}`, rate, burst); this.budget('sms:global', this.globalRate, this.globalBurst);
      this.sql.exec('INSERT INTO daily_usage VALUES (?,?,1) ON CONFLICT(app_id,day) DO UPDATE SET used=used+1', app.id, day);
      const id = crypto.randomUUID();
      this.sql.exec(`INSERT INTO jobs (id,app_id,request_key,phone,message,ttl_seconds,status,created_at,updated_at,expires_at)
        VALUES (?,?,?,?,?,?,'queued',?,?,?)`, id, app.id, data.idempotency_key, data.phone, data.message, ttl, now, now, now + ttl * 1000);
      return { job: this.one('SELECT * FROM jobs WHERE id=?', id), created: true };
    });
  }
  get(app, id) {
    this.expire(); const row = this.one('SELECT * FROM jobs WHERE app_id=? AND id=?', app, id);
    if (!row) throw new HttpError(404, 'Job not found'); return row;
  }
  cancel(app, id) {
    const row = this.get(app, id);
    if (row.status === 'cancelled') return row;
    if (row.status !== 'queued') throw new HttpError(409, 'Only queued jobs can be cancelled');
    this.sql.exec("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?", this.clock(), id);
    return this.get(app, id);
  }
  list(app, params) {
    this.expire(); const page = Number(params.get('page') ?? 0), size = Number(params.get('limit') ?? 20);
    if (!Number.isInteger(page) || page < 0 || page > 10000 || !Number.isInteger(size) || size < 1 || size > 50)
      throw new HttpError(422, 'Use page 0-10000 and limit 1-50');
    return { jobs: this.rows('SELECT * FROM jobs WHERE app_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?', app, size, page * size).map(row => publicJob(row)), page, limit: size };
  }
  counts(app) {
    this.expire(); return { pending: this.one("SELECT COUNT(*) AS n FROM jobs WHERE app_id=? AND status IN ('queued','claimed','sending')", app).n, queue_capacity: this.maxPending };
  }
  device(type, data) {
    if (!data || typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) throw new HttpError(422, 'Invalid claim token');
    if (type === 'claim') {
      this.expire(); const previous = this.one('SELECT * FROM jobs WHERE claim_token=?', data.token);
      if (previous) return previous;
      if (this.one("SELECT id FROM jobs WHERE status IN ('claimed','sending') LIMIT 1")) return null;
      const row = this.one(`SELECT j.* FROM jobs j LEFT JOIN served s ON s.app_id=j.app_id
        WHERE j.status='queued' ORDER BY COALESCE(s.at,0),j.created_at,j.rowid LIMIT 1`);
      if (!row) return null;
      return this.storage.transactionSync(() => {
        this.sql.exec("UPDATE jobs SET status='claimed',claim_token=?,updated_at=? WHERE id=?", data.token, this.clock(), row.id);
        const turn = (this.one('SELECT MAX(at) AS n FROM served')?.n || 0) + 1;
        this.sql.exec('INSERT INTO served VALUES (?,?) ON CONFLICT(app_id) DO UPDATE SET at=excluded.at', row.app_id, turn);
        return this.one('SELECT * FROM jobs WHERE id=?', row.id);
      });
    }
    if (typeof data.id !== 'string' || !ID.test(data.id)) throw new HttpError(422, 'Invalid job id');
    const row = this.one('SELECT * FROM jobs WHERE id=? AND claim_token=?', data.id, data.token);
    if (!row) throw new HttpError(404, 'Claim not found');
    if (type === 'start') {
      if (!['claimed', 'sending'].includes(row.status)) throw new HttpError(409, 'Job already completed');
      this.sql.exec("UPDATE jobs SET status='sending',updated_at=? WHERE id=?", this.clock(), row.id);
    } else if (type === 'result') {
      if (!['submitted', 'failed', 'unknown'].includes(data.status)) throw new HttpError(422, 'Invalid result status');
      if (data.error != null && (typeof data.error !== 'string' || data.error.length > 400)) throw new HttpError(422, 'Invalid error');
      if (data.modem_reference != null && (!Number.isInteger(data.modem_reference) || data.modem_reference < -1 || data.modem_reference > 255))
        throw new HttpError(422, 'Invalid modem reference');
      if (TERMINAL.has(row.status)) return row;
      if (row.status !== 'sending') throw new HttpError(409, 'Start job before reporting a result');
      this.sql.exec('UPDATE jobs SET status=?,error=?,modem_reference=?,updated_at=? WHERE id=?',
        data.status, data.error || null, data.modem_reference ?? null, this.clock(), row.id);
    } else throw new HttpError(422, 'Unknown device message type');
    return this.one('SELECT * FROM jobs WHERE id=?', row.id);
  }
}
