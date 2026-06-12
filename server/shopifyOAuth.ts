/**
 * shopifyOAuth.ts — Per-workspace Shopify OAuth install flow
 *
 * Two Express routes:
 *   GET  /api/shopify/auth     — Redirects merchant to Shopify authorize page
 *   GET  /api/shopify/callback — Handles code exchange → stores access token
 *
 * Each workspace stores its own clientId + clientSecret in workspace_credentials.
 * The state param carries workspaceId so the callback knows which workspace to update.
 */
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { getCredential, setCredential } from "./workspaceDb";

// write_inventory + read_locations: set stock levels + per-variant cost. write_publications: publish
// to the Online Store + Shop sales channels. read/write_metaobjects: resolve + auto-create colour
// swatch metaobjects and category-metafield values. (Each scope must ALSO be enabled in the Shopify
// app version's config — the granted set follows the app config, not just this request list.)
const SCOPES = "write_products,read_products,read_locations,write_inventory,write_publications,read_metaobjects,write_metaobjects";

/** A Shopify shop's admin host — the ONLY kind of host we will ever build an OAuth authorize or
 *  token-exchange URL against. Single-label `<shop>.myshopify.com` only. */
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Normalise a user/Shopify-supplied store domain to a bare host and confirm it is a real
 * *.myshopify.com domain. Returns null (caller MUST reject) otherwise. This is the guard that
 * stops an attacker-controlled `shop` param from making the server POST the client_secret to an
 * arbitrary host — an unauthenticated secret-exfiltration + SSRF (PO-flagged 2026-06-11).
 * Exported for unit testing.
 */
export function normalizeShopDomain(input: string | undefined | null): string | null {
  if (!input) return null;
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return SHOP_DOMAIN_RE.test(d) ? d : null;
}

/** Length-checked constant-time string compare (crypto.timingSafeEqual throws on length mismatch). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Register Shopify OAuth routes on the Express app.
 */
export function registerShopifyOAuthRoutes(app: Express) {
  // ─── Step 1: Initiate OAuth ─────────────────────────────────────────────────
  app.get("/api/shopify/auth", async (req: Request, res: Response) => {
    try {
      const { workspaceId, storeDomain } = req.query as {
        workspaceId?: string;
        storeDomain?: string;
      };

      if (!workspaceId || !storeDomain) {
        res.status(400).send("Missing workspaceId or storeDomain query params");
        return;
      }

      // Load per-workspace client credentials
      const clientId = await getCredential(workspaceId, "shopify", "clientId");
      if (!clientId) {
        res.status(400).send("No Shopify Client ID configured for this workspace. Save your Client ID first.");
        return;
      }

      // Validate + normalise the store domain. MUST be a real *.myshopify.com host — it becomes the
      // host of the authorize URL below (and, later, the token-exchange URL in /callback).
      const domain = normalizeShopDomain(storeDomain);
      if (!domain) {
        res.status(400).send("Invalid store domain — must be your-store.myshopify.com");
        return;
      }

      // Build a nonce for CSRF protection
      const nonce = crypto.randomBytes(16).toString("hex");
      // Encode workspaceId + nonce in state (pipe-separated)
      const state = `${workspaceId}|${nonce}`;

      // Store nonce temporarily so callback can verify (use credential store as simple KV)
      await setCredential(workspaceId, "shopify", "oauthNonce", nonce);
      await setCredential(workspaceId, "shopify", "pendingDomain", domain);

      // Always use the production domain for the redirect URI
      // (dev proxy domains like *.run.app won't be whitelisted in Shopify)
      const redirectUri = "https://nytdesignbot-2uiwq4um.manus.space/api/shopify/callback";

      const authorizeUrl =
        `https://${domain}/admin/oauth/authorize` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}`;

      res.redirect(authorizeUrl);
    } catch (err) {
      console.error("[shopifyOAuth] /auth error:", err);
      res.status(500).send("Internal error initiating Shopify OAuth");
    }
  });

  // ─── Step 2: Handle callback ────────────────────────────────────────────────
  app.get("/api/shopify/callback", async (req: Request, res: Response) => {
    try {
      const { code, state, hmac, shop } = req.query as {
        code?: string;
        state?: string;
        hmac?: string;
        shop?: string;
      };

      if (!code || !state || !hmac) {
        res.status(400).send("Missing code, state, or hmac from Shopify callback");
        return;
      }

      // Parse state → workspaceId + nonce
      const [workspaceId, nonce] = state.split("|");
      if (!workspaceId || !nonce) {
        res.status(400).send("Invalid state parameter");
        return;
      }

      // Verify nonce (constant-time)
      const storedNonce = await getCredential(workspaceId, "shopify", "oauthNonce");
      if (!storedNonce || !safeEqual(storedNonce, nonce)) {
        res.status(403).send("State mismatch — possible CSRF. Please try connecting again.");
        return;
      }

      // Load credentials
      const clientId = await getCredential(workspaceId, "shopify", "clientId");
      const clientSecret = await getCredential(workspaceId, "shopify", "clientSecret");

      // ─── HMAC verification (Shopify's documented authenticity check) ──────────
      // Build the message: sorted query params excluding `hmac`, joined as key=value pairs with &
      if (!clientSecret) {
        res.status(400).send("Missing Shopify client secret for this workspace");
        return;
      }
      const queryParams = { ...req.query } as Record<string, string>;
      delete queryParams.hmac;
      const sortedMessage = Object.keys(queryParams)
        .sort()
        .map((k) => `${k}=${queryParams[k]}`)
        .join("&");
      const computedHmac = crypto
        .createHmac("sha256", clientSecret)
        .update(sortedMessage)
        .digest("hex");
      if (!safeEqual(computedHmac, hmac)) {
        console.error("[shopifyOAuth] HMAC mismatch — callback rejected");
        res.status(403).send("HMAC verification failed — callback rejected");
        return;
      }
      // Validate the shop domain BEFORE it becomes the token-exchange host. Shopify sends `shop`;
      // fall back to the domain stored at /auth. Either way it MUST be a real *.myshopify.com host —
      // this is the guard against POSTing client_secret to an attacker-controlled server.
      const storeDomain = normalizeShopDomain(
        shop || (await getCredential(workspaceId, "shopify", "pendingDomain"))
      );

      if (!clientId || !clientSecret || !storeDomain) {
        res.status(400).send("Missing or invalid Shopify app credentials/domain for this workspace");
        return;
      }

      // Exchange code for permanent access token
      const tokenUrl = `https://${storeDomain}/admin/oauth/access_token`;
      const tokenRes = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error("[shopifyOAuth] Token exchange failed:", tokenRes.status, errText);
        res.status(502).send(`Shopify token exchange failed (${tokenRes.status}): ${errText}`);
        return;
      }

      const tokenData = (await tokenRes.json()) as { access_token: string; scope: string };
      const accessToken = tokenData.access_token;

      if (!accessToken) {
        res.status(502).send("Shopify did not return an access token");
        return;
      }

      // Persist the access token, store domain, and the scopes Shopify actually GRANTED (so we can
      // verify a reconnect picked up the new inventory/channel permissions). PO 2026-06-12.
      await setCredential(workspaceId, "shopify", "accessToken", accessToken);
      await setCredential(workspaceId, "shopify", "storeDomain", storeDomain);
      await setCredential(workspaceId, "shopify", "grantedScope", tokenData.scope ?? "");

      // Clean up temp nonce
      await setCredential(workspaceId, "shopify", "oauthNonce", "");
      await setCredential(workspaceId, "shopify", "pendingDomain", "");

      // Redirect back to workspace settings with success indicator
      res.redirect(`/workspace-settings?shopify=connected`);
    } catch (err) {
      console.error("[shopifyOAuth] /callback error:", err);
      res.status(500).send("Internal error completing Shopify OAuth");
    }
  });
}
