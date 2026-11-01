import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"
import { ApiError, RateLimitError, SANDBOX_KEY, ScOrgsClient, bearer } from "../dist/esm/index.js"
import { fakeFetch } from "./helpers.mjs"

test("bearer() accepts sco_live_ and sco_test_ keys only", () => {
  assert.equal(bearer(SANDBOX_KEY), `Bearer ${SANDBOX_KEY}`)
  assert.throws(() => bearer("sco_abc"), TypeError)
  assert.throws(() => bearer("scmp_live_x"), TypeError)
  assert.throws(() => new ScOrgsClient({ token: "nope" }), TypeError)
})

test("getMe() sends the key and unwraps data", async () => {
  const fetch = fakeFetch([{ body: "me.json" }])
  const sco = new ScOrgsClient({ token: SANDBOX_KEY, fetch })
  const me = await sco.getMe()
  assert.equal(me.organization.sid, "~SANDBOX")
  assert.equal(me.key.realm, "test")
  assert.equal(fetch.calls[0].url, "https://api.sc-orgs.space/api/v1/me")
  assert.equal(fetch.calls[0].headers.Authorization, `Bearer ${SANDBOX_KEY}`)
})

test("iterateMembers() walks every page and encodes the org", async () => {
  const fetch = fakeFetch([{ body: "members-page1.json" }, { body: "members-page2.json" }])
  const sco = new ScOrgsClient({ token: SANDBOX_KEY, fetch })
  const handles = []
  for await (const m of sco.iterateMembers("~SANDBOX", { page_size: 2 })) handles.push(m.rsi_handle)
  assert.deepEqual(handles, ["~sandbox-owner", "~sandbox-alice", "~sandbox-bob", "~sandbox-carol"])
  const first = new URL(fetch.calls[0].url)
  assert.equal(first.pathname, "/api/v1/orgs/~SANDBOX/members")
  assert.equal(first.searchParams.get("page_size"), "2")
  assert.equal(new URL(fetch.calls[1].url).searchParams.get("page"), "2")
})

test("listEvents() passes the window; no key means no Authorization header", async () => {
  const fetch = fakeFetch([{ body: "events.json" }])
  const sco = new ScOrgsClient({ fetch })
  const { events, total } = await sco.listEvents("~SANDBOX", { from: "2026-11-01T00:00:00Z", status: "upcoming" })
  assert.equal(total, 4)
  assert.equal(events[0].title, "Sandbox: Mining run")
  const url = new URL(fetch.calls[0].url)
  assert.equal(url.searchParams.get("from"), "2026-11-01T00:00:00Z")
  assert.equal(url.searchParams.get("status"), "upcoming")
  assert.equal(fetch.calls[0].headers.Authorization, undefined)
})

test("a 429 is retried after Retry-After, then the error surfaces", async () => {
  const limited = { status: 429, body: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Slow down" } }, headers: { "retry-after": "0" } }
  const fetch = fakeFetch([limited, limited, limited])
  const retries = []
  const sco = new ScOrgsClient({ token: SANDBOX_KEY, fetch, maxRetries: 2, onRetry: (i) => retries.push(i.attempt) })
  await assert.rejects(sco.getMe(), (e) => e instanceof RateLimitError && e.code === "RATE_LIMIT_EXCEEDED" && e.retryAfter === 0)
  assert.deepEqual(retries, [1, 2])
  assert.equal(fetch.remaining(), 0)
})

test("errors carry the API's code", async () => {
  const fetch = fakeFetch([{ status: 401, body: "unauthorized.json" }, { status: 404, body: "org-not-found.json" }])
  const sco = new ScOrgsClient({ token: SANDBOX_KEY, fetch })
  await assert.rejects(sco.getMe(), (e) => e instanceof ApiError && e.status === 401 && e.code === "UNAUTHORIZED")
  await assert.rejects(sco.getOrganization("~SANDBOX"), (e) => e.code === "NOT_FOUND" && e.message === "NOT_FOUND: Organization not found")
})

test("the CommonJS build loads with require()", () => {
  const cjs = createRequire(import.meta.url)("../dist/cjs/index.js")
  assert.equal(typeof cjs.ScOrgsClient, "function")
  assert.equal(typeof cjs.verifyWebhook, "function")
})
