import assert from "node:assert/strict"
import { test } from "node:test"
import { WebhookVerificationError, constructEvent, signWebhook, verifyWebhook } from "../dist/esm/index.js"
import { fixture } from "./helpers.mjs"

// Signed by the server's own signing code (see fixtures/README.md).
const v = JSON.parse(fixture("webhook-signed.json"))
const now = v.timestamp + 10

test("accepts a delivery signed by the server, with either rotated secret", async () => {
  assert.equal(await verifyWebhook(v.secret, v.headers, v.body, { now }), true)
  assert.equal(await verifyWebhook(v.previous_secret, v.headers, v.body, { now }), true)
})

test("works with Fetch Headers, Node-style header objects and raw bytes", async () => {
  assert.equal(await verifyWebhook(v.secret, new Headers(v.headers), v.body, { now }), true)
  const node = { "Webhook-Id": [v.headers["webhook-id"]], "webhook-timestamp": v.headers["webhook-timestamp"], "webhook-signature": v.headers["webhook-signature"] }
  assert.equal(await verifyWebhook(v.secret, node, new TextEncoder().encode(v.body), { now }), true)
})

test("refuses a changed body, a wrong secret, a stale timestamp and missing headers", async () => {
  assert.equal(await verifyWebhook(v.secret, v.headers, v.body.replace("invite", "inv1te"), { now }), false)
  assert.equal(await verifyWebhook("whsec_" + btoa("x".repeat(32)), v.headers, v.body, { now }), false)
  assert.equal(await verifyWebhook(v.secret, v.headers, v.body, { now: v.timestamp + 301 }), false)
  assert.equal(await verifyWebhook(v.secret, { "webhook-id": "x" }, v.body, { now }), false)
  await assert.rejects(verifyWebhook("not-a-secret", v.headers, v.body, { now }), TypeError)
})

test("constructEvent() verifies then parses; it says why it failed", async () => {
  const event = await constructEvent(v.secret, v.headers, v.body, { now })
  assert.equal(event.type, "member.joined")
  assert.equal(event.organization.sid, "~SANDBOX")
  await assert.rejects(constructEvent(v.secret, v.headers, v.body, { now: v.timestamp - 1000 }), (e) => e instanceof WebhookVerificationError && /too old/.test(e.message))
})

test("signWebhook() matches the server's signature", async () => {
  const sig = await signWebhook(v.secret, v.headers["webhook-id"], v.timestamp, v.body)
  assert.equal(sig, v.headers["webhook-signature"].split(" ")[0])
})
