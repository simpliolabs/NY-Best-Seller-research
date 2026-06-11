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

const SCOPES = "write_products,read_products";

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

      // Normalise domain
      const domain = storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

      // Build a nonce for CSRF protection
      const nonce = crypto.randomBytes(16).toString("hex");
      // Encode workspaceId + nonce in state (pipe-separated)
      const state = `${workspaceId}|${nonce}`;

      // Store nonce temporarily so callback can verify (use credential store as simple KV)
      await setCredential(workspaceId, "shopify", "oauthNonce", nonce);
      await setCredential(workspaceId, "shopify", "pendingDomain", domain);

      // Determine redirect URI — use the production domain
      const host = req.get("host") || "nytdesignbot-2uiwq4um.manus.space";
      const protocol = req.get("x-forwarded-proto") || req.protocol || "https";
      const redirectUri = `${protocol}://${host}/api/shopify/callback`;

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

      if (!code || !state) {
        res.status(400).send("Missing code or state from Shopify callback");
        return;
      }

      // Parse state → workspaceId + nonce
      const [workspaceId, nonce] = state.split("|");
      if (!workspaceId || !nonce) {
        res.status(400).send("Invalid state parameter");
        return;
      }

      // Verify nonce
      const storedNonce = await getCredential(workspaceId, "shopify", "oauthNonce");
      if (!storedNonce || storedNonce !== nonce) {
        res.status(403).send("State mismatch — possible CSRF. Please try connecting again.");
        return;
      }

      // Load credentials
      const clientId = await getCredential(workspaceId, "shopify", "clientId");
      const clientSecret = await getCredential(workspaceId, "shopify", "clientSecret");
      const storeDomain = shop || (await getCredential(workspaceId, "shopify", "pendingDomain"));

      if (!clientId || !clientSecret || !storeDomain) {
        res.status(400).send("Missing Shopify app credentials for this workspace");
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

      // Persist the access token and store domain
      await setCredential(workspaceId, "shopify", "accessToken", accessToken);
      await setCredential(workspaceId, "shopify", "storeDomain", storeDomain);

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
