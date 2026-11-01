import { readFileSync } from "node:fs"

export const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

/**
 * A fake fetch: each call takes the next scripted response and records the
 * request. `responses` items: { status, body (fixture name or object), headers }.
 */
export function fakeFetch(responses) {
  const calls = []
  const queue = [...responses]
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: { ...init.headers }, body: init.body })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected request ${url}`)
    const text = typeof next.body === "string" && next.body.endsWith(".json") ? fixture(next.body) : typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? "")
    const type = next.type ?? "application/json; charset=utf-8"
    return new Response(text, { status: next.status ?? 200, headers: { "content-type": type, ...next.headers } })
  }
  fn.calls = calls
  fn.remaining = () => queue.length
  return fn
}
