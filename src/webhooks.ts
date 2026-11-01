/**
 * SC Orgs webhooks: Standard Webhooks signatures (https://www.standardwebhooks.com/),
 * matching the server (backend/src/services/webhooks/signing.ts):
 *
 *   webhook-id:        msg_…        unique per event and webhook; use it as your idempotency key
 *   webhook-timestamp: 1793145600   unix seconds
 *   webhook-signature: v1,<base64(HMAC-SHA256(secret bytes, "{id}.{timestamp}.{body}"))>
 *
 * The secret is `whsec_` + base64 of 32 bytes; the HMAC key is the decoded
 * bytes. During a secret rotation both secrets sign, space-separated, so one
 * matching signature is enough. Timestamps more than 5 minutes off are
 * refused. Uses Web Crypto (Node 18+, browsers, Deno, Bun, Workers): no dependencies.
 *
 * Always verify the raw body exactly as received: parse the JSON afterwards.
 */

export const SECRET_PREFIX = "whsec_"
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60

/** The event types (sc-orgs.space/developers#webhooks). `ping` is the Send test button. */
export type WebhookEventType =
  | "member.joined"
  | "member.left"
  | "member.roles_updated"
  | "event.created"
  | "event.updated"
  | "event.cancelled"
  | "event.starting"
  | "ping"

/**
 * The body of every delivery. `data` depends on the type, e.g.
 * member.joined: `{ member, via }`; event.starting: `{ event, starts_in_seconds }`.
 * When the webhook's key has lost a scope the event needs, `data` is cut
 * down to ids.
 */
export interface WebhookEvent<TData = Record<string, unknown>> {
  id: string
  type: WebhookEventType | (string & {})
  api_version: string
  /** ISO 8601. */
  occurred_at: string
  organization: { id: string; sid: string | null }
  data: TData
}

/** A Fetch `Headers`, or a plain object such as Express/Node's `req.headers`. */
export type WebhookHeaders = Headers | { [name: string]: string | string[] | undefined }

export interface VerifyOptions {
  /** Allowed clock difference in seconds (default 300). */
  toleranceSeconds?: number
  /** "Now" in unix seconds, for tests. */
  now?: number
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebhookVerificationError"
  }
}

const encoder = new TextEncoder()

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function bodyBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return encoder.encode(body)
  return body instanceof Uint8Array ? body : new Uint8Array(body)
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error("Web Crypto isn't available (Node 18+ has it as globalThis.crypto)")
  return s
}

async function hmac(secret: string, msgId: string, timestamp: number | string, body: string | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (typeof secret !== "string" || !secret.startsWith(SECRET_PREFIX)) throw new TypeError(`Webhook secrets start with ${SECRET_PREFIX}`)
  const key = await subtle().importKey("raw", fromBase64(secret.slice(SECRET_PREFIX.length)) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const prefix = encoder.encode(`${msgId}.${timestamp}.`)
  const raw = bodyBytes(body)
  const message = new Uint8Array(prefix.length + raw.length)
  message.set(prefix)
  message.set(raw, prefix.length)
  return new Uint8Array(await subtle().sign("HMAC", key, message as BufferSource))
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** The `webhook-signature` value for a body: for testing your own receiver. */
export async function signWebhook(secret: string, msgId: string, timestamp: number, body: string | Uint8Array): Promise<string> {
  return `v1,${toBase64(await hmac(secret, msgId, timestamp, body))}`
}

/**
 * Check a delivery; throws WebhookVerificationError saying why it failed.
 * `body` is the raw request body (string or bytes), not parsed JSON.
 */
export async function assertValidWebhook(secret: string, headers: WebhookHeaders, body: string | Uint8Array | ArrayBuffer, options: VerifyOptions = {}): Promise<void> {
  const id = header(headers, "webhook-id")
  const tsRaw = header(headers, "webhook-timestamp")
  const sigs = header(headers, "webhook-signature")
  if (!id || !tsRaw || !sigs) throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header")
  const ts = Number(tsRaw)
  if (!Number.isInteger(ts)) throw new WebhookVerificationError("Invalid webhook-timestamp")
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > (options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) throw new WebhookVerificationError("webhook-timestamp is too old or too far in the future")
  const expected = await hmac(secret, id, ts, body)
  const ok = sigs.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2)
    if (version !== "v1" || !value) return false
    try {
      return timingSafeEqual(fromBase64(value), expected)
    } catch {
      return false
    }
  })
  if (!ok) throw new WebhookVerificationError("No matching signature")
}

/** True when one signature matches and the timestamp is fresh. */
export async function verifyWebhook(secret: string, headers: WebhookHeaders, body: string | Uint8Array | ArrayBuffer, options?: VerifyOptions): Promise<boolean> {
  try {
    await assertValidWebhook(secret, headers, body, options)
    return true
  } catch (e) {
    if (e instanceof WebhookVerificationError) return false
    throw e
  }
}

/** Verify, then parse the body. Throws WebhookVerificationError when the signature doesn't check out. */
export async function constructEvent<TData = Record<string, unknown>>(secret: string, headers: WebhookHeaders, body: string | Uint8Array | ArrayBuffer, options?: VerifyOptions): Promise<WebhookEvent<TData>> {
  await assertValidWebhook(secret, headers, body, options)
  const text = typeof body === "string" ? body : new TextDecoder().decode(bodyBytes(body))
  return JSON.parse(text) as WebhookEvent<TData>
}
