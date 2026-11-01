// Receive SC Orgs webhooks in an Express app and check their signatures.
//
//   npm install express
//   SCO_WEBHOOK_SECRET=whsec_…  node examples/express-webhook.mjs
//
// Add the webhook in your org under Manage → API → Webhooks, pointing at
// https://your-host/sc-orgs/webhook, and copy its signing secret (whsec_…).
// "Send test" delivers a `ping` event.
import express from "express"
import { WebhookVerificationError, constructEvent } from "@sc-orgs/sdk"

const secret = process.env.SCO_WEBHOOK_SECRET
if (!secret) throw new Error("Set SCO_WEBHOOK_SECRET (the webhook's whsec_… signing secret)")

const app = express()
const seen = new Set() // use a database in production: webhook-id is the idempotency key

// express.raw: the signature covers the exact bytes sent, so don't let a JSON parser touch the body first.
app.post("/sc-orgs/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event
  try {
    event = await constructEvent(secret, req.headers, req.body)
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.status(400).send(e.message)
    throw e
  }
  const id = req.headers["webhook-id"]
  if (seen.has(id)) return res.sendStatus(200) // a redelivery: already handled
  seen.add(id)

  switch (event.type) {
    case "member.joined":
      console.log(`${event.data.member?.rsi_handle} joined ${event.organization.sid}`)
      break
    case "event.starting":
      console.log(`"${event.data.event?.title}" starts in ${Math.round(event.data.starts_in_seconds / 60)} min`)
      break
    default:
      console.log(event.type, event.data)
  }
  // Answer quickly with a 2xx; do slow work afterwards.
  res.sendStatus(200)
})

// Loopback by default: put a TLS reverse proxy (nginx, Caddy, a Cloudflare Tunnel) in front
// and forward /sc-orgs/webhook to it, rather than exposing this port directly.
const host = process.env.HOST ?? "127.0.0.1"
const port = Number(process.env.PORT ?? 3000)
app.listen(port, host, () => console.log(`Listening on http://${host}:${port}`))
