/**
 * The transport every client shares: native fetch, `{ "data": … }`
 * unwrapping, typed errors, pagination and 429/503 retries that respect
 * Retry-After. No runtime dependencies.
 */

/** A query value; `undefined` and `null` are left out, arrays repeat the key. */
export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>

export interface RetryInfo {
  /** 1 for the first retry. */
  attempt: number
  status: number
  /** How long the client waits before retrying, in seconds. */
  delaySeconds: number
  method: string
  url: string
}

export interface ClientOptions {
  /** Your API token. Keep it on a server: never ship it to a browser. */
  token?: string
  /** Defaults to the production API. */
  baseUrl?: string
  /** A fetch implementation; defaults to `globalThis.fetch` (Node 18+, browsers, Deno, Bun, Workers). */
  fetch?: typeof fetch
  /**
   * Retries after a 429 or 503 response, waiting the server's Retry-After
   * (or 1 s, 2 s, 4 s… without one). Default 3; 0 turns retries off.
   */
  maxRetries?: number
  /**
   * The longest wait the client accepts, in seconds (default 60). When the
   * server asks for longer, the request fails with a RateLimitError instead
   * of sleeping.
   */
  maxRetryDelay?: number
  /** Per-request timeout in milliseconds (default 30 000; 0 turns it off). */
  timeout?: number
  /** Extra headers on every request, e.g. a `User-Agent` naming your tool. */
  headers?: Record<string, string>
  /** Called before each retry (logging, metrics). */
  onRetry?: (info: RetryInfo) => void
}

export interface RequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
}

interface InternalRequest extends RequestOptions {
  query?: object
  body?: unknown
}

/** The `error` object of every non-2xx response. */
export interface ErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
  validationErrors?: Array<{ field?: string; message?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** A non-2xx response. `code` is the API's machine-readable error code. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown>
  readonly validationErrors?: ErrorBody["validationErrors"]
  /** Seconds from Retry-After, on 429 and 503. */
  readonly retryAfter?: number
  /** The X-Request-Id header, if the server sent one: quote it when reporting a problem. */
  readonly requestId?: string
  /** The parsed response body (or its text when it wasn't JSON). */
  readonly body: unknown

  constructor(status: number, body: unknown, headers: Headers) {
    const err = (body && typeof body === "object" && "error" in body ? (body as { error: ErrorBody }).error : undefined) ?? undefined
    super(err?.message ? `${err.code ?? status}: ${err.message}` : `HTTP ${status}`)
    this.name = "ApiError"
    this.status = status
    this.code = err?.code ?? `HTTP_${status}`
    this.details = err?.details
    this.validationErrors = err?.validationErrors
    this.retryAfter = parseRetryAfter(headers.get("retry-after"))
    this.requestId = headers.get("x-request-id") ?? undefined
    this.body = body
  }
}

/** A 429 (or 503) the client gave up on: retries used up, or Retry-After above maxRetryDelay. */
export class RateLimitError extends ApiError {
  constructor(status: number, body: unknown, headers: Headers) {
    super(status, body, headers)
    this.name = "RateLimitError"
  }
}

/** Retry-After in seconds: delta-seconds or an HTTP date. Undefined when absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value == null || value.trim() === "") return undefined
  const v = value.trim()
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v)
  const at = Date.parse(v)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, Math.ceil((at - now) / 1000))
}

/** `?a=1&b=x&b=y`, skipping undefined and null. */
export function buildQuery(query: object | undefined): string {
  if (!query) return ""
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query as Record<string, QueryValue>)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v))
    else params.append(key, String(value))
  }
  const s = params.toString()
  return s ? `?${s}` : ""
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return undefined
  const type = res.headers.get("content-type") ?? ""
  if (type.includes("json")) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

export interface TransportDefaults {
  baseUrl: string
}

/** The base of the generated clients. */
export abstract class BaseClient {
  protected readonly baseUrl: string
  protected readonly token?: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly maxRetryDelay: number
  private readonly timeout: number
  private readonly headers: Record<string, string>
  private readonly onRetry?: (info: RetryInfo) => void

  protected constructor(options: ClientOptions, defaults: TransportDefaults) {
    this.baseUrl = (options.baseUrl ?? defaults.baseUrl).replace(/\/+$/, "")
    this.token = options.token
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined)
    if (!f) throw new Error("No fetch available: pass options.fetch (Node 18+ has one built in)")
    this.fetchImpl = f
    this.maxRetries = options.maxRetries ?? 3
    this.maxRetryDelay = options.maxRetryDelay ?? 60
    this.timeout = options.timeout ?? 30_000
    this.headers = { ...options.headers }
    this.onRetry = options.onRetry
  }

  /** Send a request and return the response's `data`. */
  protected async request<T>(method: string, path: string, opts: InternalRequest = {}): Promise<T> {
    const body = await this.send(method, path, opts)
    return (body && typeof body === "object" && "data" in body ? (body as { data: T }).data : body) as T
  }

  /** Send a request and return the parsed body as is. */
  protected async send(method: string, path: string, opts: InternalRequest = {}): Promise<unknown> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`
    const headers: Record<string, string> = { Accept: "application/json", ...this.headers, ...opts.headers }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    let payload: string | undefined
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json"
      payload = JSON.stringify(opts.body)
    }

    for (let attempt = 0; ; attempt++) {
      const signal = this.signalFor(opts.signal)
      const res = await this.fetchImpl(url, { method, headers, body: payload, signal })
      const parsed = await readBody(res)
      if (res.ok) return parsed

      // 429: a rate limit. 503: the API is busy (it rejects before doing any
      // work, so a retry is safe even for a write).
      const retryable = res.status === 429 || res.status === 503
      if (!retryable) throw new ApiError(res.status, parsed, res.headers)
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"))
      const delay = retryAfter ?? Math.min(2 ** attempt, this.maxRetryDelay)
      if (attempt >= this.maxRetries || delay > this.maxRetryDelay) throw new RateLimitError(res.status, parsed, res.headers)
      this.onRetry?.({ attempt: attempt + 1, status: res.status, delaySeconds: delay, method, url })
      await sleep(delay * 1000, opts.signal)
    }
  }

  private signalFor(user?: AbortSignal): AbortSignal | undefined {
    if (!this.timeout) return user
    const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(this.timeout) : undefined
    if (!user) return timeout
    if (!timeout) return user
    const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
    return any ? any([user, timeout]) : user
  }

  /**
   * Walk a paginated list: calls `fetchPage(1)`, `fetchPage(2)`… and yields
   * every item under `key`, stopping after `total` items or an empty page.
   */
  protected async *paginate<I>(
    fetchPage: (page: number) => Promise<{ total: number; page: number; page_size: number }>,
    key: string,
  ): AsyncGenerator<I> {
    let seen = 0
    for (let page = 1; ; page++) {
      const data = (await fetchPage(page)) as unknown as Record<string, unknown> & { total: number }
      const items = (data[key] as I[] | undefined) ?? []
      for (const item of items) yield item
      seen += items.length
      if (items.length === 0 || seen >= data.total) return
    }
  }
}
