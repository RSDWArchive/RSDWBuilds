import { createClient } from "npm:@supabase/supabase-js@2";
import jwt from "npm:jsonwebtoken@9.0.2";

export type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const GITHUB_APP_ID = mustEnv("GITHUB_APP_ID");
const GITHUB_INSTALLATION_ID = Deno.env.get("GITHUB_INSTALLATION_ID") || "";
export const GITHUB_OWNER = Deno.env.get("GITHUB_OWNER") || "RSDWArchive";
export const GITHUB_REPO = Deno.env.get("GITHUB_REPO") || "RSDWBuilds";
export const GITHUB_BRANCH = Deno.env.get("GITHUB_BRANCH") || "main";
export const DEPLOY_WORKFLOW_ID = Deno.env.get("DEPLOY_WORKFLOW_ID") || "deploy-pages.yml";
export const REPLACE_WORKFLOW_ID = Deno.env.get("REPLACE_WORKFLOW_ID") || "replace-entry.yml";
export const SITE_ASSETS_WORKFLOW_ID = Deno.env.get("SITE_ASSETS_WORKFLOW_ID") || "sync-site-assets.yml";

const ALLOWED_ORIGINS = (Deno.env.get("UPLOAD_ALLOWED_ORIGINS") ||
  "https://rsdwbuilds.com,http://localhost:8000,http://127.0.0.1:8000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const supabaseAdmin = createClient(SUPABASE_URL, supabaseSecretKey());

export class AuthError extends Error {}

export function mustEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function supabaseSecretKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) throw new Error("Missing Supabase service secret.");
  const parsed = JSON.parse(raw);
  const key = parsed.default || Object.values(parsed)[0];
  if (!key || typeof key !== "string") throw new Error("Supabase service secret is empty.");
  return key;
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(body: JsonRecord, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });
}

export function bearerToken(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

export async function requireUser(req: Request): Promise<any> {
  const token = bearerToken(req);
  if (!token) throw new AuthError("Sign in before continuing.");
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new AuthError("Your sign-in session is no longer valid.");
  return data.user;
}

export function githubUsernameFromUser(user: any): string {
  const identities = Array.isArray(user.identities) ? user.identities : [];
  const githubIdentity = identities.find((identity) => identity.provider === "github");
  const identityData = githubIdentity?.identity_data || {};
  const metadata = user.user_metadata || {};
  return String(
    metadata.user_name ||
    metadata.preferred_username ||
    metadata.login ||
    identityData.user_name ||
    identityData.preferred_username ||
    identityData.login ||
    "",
  ).trim().toLowerCase();
}

export async function requireManager(req: Request): Promise<{ user: any; username: string }> {
  const user = await requireUser(req);
  const username = githubUsernameFromUser(user);
  if (!username) throw new AuthError("GitHub username was not available in the signed-in profile.");
  const { data, error } = await supabaseAdmin
    .from("approved_managers")
    .select("github_username")
    .eq("github_username", username)
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AuthError("This GitHub account is not approved for management.");
  return { user, username };
}

function privateKey(): string {
  const direct = Deno.env.get("GITHUB_PRIVATE_KEY");
  if (direct) return direct.replace(/\\n/g, "\n");
  const encoded = Deno.env.get("GITHUB_PRIVATE_KEY_B64");
  if (encoded) return atob(encoded).replace(/\\n/g, "\n");
  throw new Error("Missing GitHub App private key.");
}

async function createAppJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 540, iss: GITHUB_APP_ID },
    privateKey(),
    { algorithm: "RS256" },
  );
}

async function resolveInstallationId(appJwt: string): Promise<string> {
  if (GITHUB_INSTALLATION_ID) return GITHUB_INSTALLATION_ID;
  const response = await githubFetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/installation`,
    { method: "GET", headers: { Authorization: `Bearer ${appJwt}` } },
  );
  const body = await response.json();
  if (!response.ok || !body.id) {
    throw new Error(`Could not resolve GitHub installation id: ${response.status}`);
  }
  return String(body.id);
}

export async function createInstallationToken(): Promise<string> {
  const appJwt = await createAppJwt();
  const installationId = await resolveInstallationId(appJwt);
  const response = await githubFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: { Authorization: `Bearer ${appJwt}` } },
  );
  const body = await response.json();
  if (!response.ok || !body.token) {
    throw new Error(`Could not create GitHub installation token: ${response.status}`);
  }
  return body.token;
}

export function githubFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function githubJson<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await githubFetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub API failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body as T;
}

export async function dispatchWorkflow(token: string, workflowId: string, inputs: JsonRecord = {}): Promise<void> {
  const response = await githubFetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: GITHUB_BRANCH, inputs }),
    },
  );
  if (response.status !== 204 && !response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`GitHub workflow dispatch failed: ${response.status} ${JSON.stringify(body)}`);
  }
}

export async function recordManagementAction(row: JsonRecord): Promise<void> {
  const { error } = await supabaseAdmin.from("management_actions").insert(row);
  if (error) console.warn("[management] audit failed", error);
}
