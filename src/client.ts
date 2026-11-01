import { bearer } from "./auth.js"
import { GeneratedScOrgsClient } from "./generated/client.js"
import type { ClientOptions } from "./http.js"

export const DEFAULT_BASE_URL = "https://api.sc-orgs.space/api/v1"

/** The shared read-only sandbox key from sc-orgs.space/developers: it only sees the ~SANDBOX test org. */
export const SANDBOX_KEY = "sco_test_hKI7h4mK1eSEen1hfCCBUXOSQnKxIFbHSPcPM7sXVAl"
export const SANDBOX_ORG = "~SANDBOX"

export interface ScOrgsClientOptions extends ClientOptions {
  /**
   * An org API key, `sco_live_…` or `sco_test_…`. Optional: without one,
   * the operations that allow it return the public view (public orgs and
   * events); the rest answer 401.
   */
  token?: string
}

/**
 * The SC Orgs public API (org profile, members, roles, events, RSVPs).
 *
 * ```ts
 * const sco = new ScOrgsClient({ token: process.env.SCO_API_KEY })
 * const { organization } = await sco.getMe()
 * for await (const m of sco.iterateMembers(organization.sid)) console.log(m.rsi_handle)
 * ```
 */
export class ScOrgsClient extends GeneratedScOrgsClient {
  constructor(options: ScOrgsClientOptions = {}) {
    if (options.token !== undefined) bearer(options.token) // validates the prefix
    super(options, { baseUrl: DEFAULT_BASE_URL })
  }
}
