/** SC Orgs org API keys: `sco_live_…`, or `sco_test_…` for test-realm orgs (Manage → API on sc-orgs.space). */
export const KEY_PREFIX = "sco_"

/** True for a string shaped like an org API key. Doesn't check it with the server. */
export function isApiKey(key: unknown): key is string {
  return typeof key === "string" && /^sco_(live|test)_\S+$/.test(key)
}

/**
 * The `Authorization` header value for a key, for use with your own HTTP
 * client: `fetch(url, { headers: { Authorization: bearer(key) } })`.
 * Throws on anything that isn't an `sco_live_` / `sco_test_` key.
 */
export function bearer(key: string): string {
  if (!isApiKey(key)) throw new TypeError("SC Orgs API keys start with sco_live_ or sco_test_ (create one in your org under Manage → API on sc-orgs.space)")
  return `Bearer ${key}`
}

/** `{ Authorization: "Bearer sco_…" }`. */
export function authHeaders(key: string): { Authorization: string } {
  return { Authorization: bearer(key) }
}
