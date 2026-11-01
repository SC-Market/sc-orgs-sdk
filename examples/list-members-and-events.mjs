// List your org's members and its events of the next 30 days.
//
//   SCO_API_KEY=sco_live_…  node examples/list-members-and-events.mjs
//
// Key scopes: members:read, events:read. Without SCO_API_KEY it uses the public
// sandbox key, which only sees the ~SANDBOX test org, so you can try it right away.
import { SANDBOX_KEY, ScOrgsClient } from "@sc-orgs/sdk"

const sco = new ScOrgsClient({ token: process.env.SCO_API_KEY ?? SANDBOX_KEY })

// The key belongs to one org: /me says which.
const { organization, effective_scopes } = await sco.getMe()
console.log(`${organization.name} (${organization.sid}); this key can use: ${effective_scopes.join(", ")}\n`)

console.log("Members")
for await (const m of sco.iterateMembers(organization.sid)) {
  const roles = m.roles.map((r) => r.name).join(", ") || "no role"
  console.log(`  ${m.rsi_handle.padEnd(24)} ${roles}${m.is_hidden ? " (hidden from the public list)" : ""}`)
}

console.log("\nEvents (next 30 days)")
for await (const e of sco.iterateEvents(organization.sid)) {
  const seats = e.max_participants ? `${e.rsvp_count}/${e.max_participants}` : `${e.rsvp_count}`
  console.log(`  ${e.start_time}  ${e.title}  [${e.status}]  ${seats} signed up`)
}
