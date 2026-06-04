import { createClient } from "npm:@supabase/supabase-js@2";
import jwt from "npm:jsonwebtoken@9.0.2";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const GITHUB_APP_ID = mustEnv("GITHUB_APP_ID");
const GITHUB_INSTALLATION_ID = Deno.env.get("GITHUB_INSTALLATION_ID") || "";
const GITHUB_OWNER = Deno.env.get("GITHUB_OWNER") || "RSDWArchive";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") || "RSDWBuilds";
const GITHUB_BRANCH = Deno.env.get("GITHUB_BRANCH") || "main";
const GITHUB_WORKFLOW_ID = Deno.env.get("GITHUB_WORKFLOW_ID") || "process-submissions.yml";
const MAX_ZIP_BYTES = Number(Deno.env.get("MAX_ZIP_BYTES") || 25 * 1024 * 1024);
const ALLOWED_ORIGINS = (Deno.env.get("UPLOAD_ALLOWED_ORIGINS") ||
  "https://rsdwbuilds.com,http://localhost:8000,http://127.0.0.1:8000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const supabaseAdmin = createClient(SUPABASE_URL, supabaseSecretKey());

Deno.serve(async (req) => {
  const headers = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, headers);
  }

  try {
    const authToken = bearerToken(req);
    if (!authToken) {
      return json({ error: "Sign in before uploading." }, 401, headers);
    }

    const user = await requireUser(authToken);
    const githubUsername = githubUsernameFromUser(user);
    if (!githubUsername) {
      return json({ error: "GitHub username was not available in the signed-in profile." }, 403, headers);
    }

    const usernameLower = githubUsername.toLowerCase();
    const allowed = await isApprovedUploader(usernameLower);
    if (!allowed) {
      return json({ error: "This GitHub account is not approved for uploads." }, 403, headers);
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return json({ error: "Missing file field." }, 400, headers);
    }

    const fileError = await validateZip(file);
    if (fileError) {
      return json({ error: fileError }, 400, headers);
    }

    const repoPath = makeRepoPath(usernameLower, file.name);
    const content = arrayBufferToBase64(await file.arrayBuffer());
    const githubToken = await createInstallationToken();
    const upload = await createRepoFile(githubToken, repoPath, content, usernameLower);
    const workflow = await dispatchWorkflow(githubToken, repoPath);

    await recordUpload({
      github_username: usernameLower,
      original_filename: file.name,
      file_size_bytes: file.size,
      repo_path: repoPath,
      upload_commit_sha: upload.sha,
      upload_commit_url: upload.html_url,
      workflow_url: workflow.html_url,
    });

    return json({
      ok: true,
      path: repoPath,
      commit_sha: upload.sha,
      commit_html_url: upload.html_url,
      workflow_html_url: workflow.html_url,
    }, 200, headers);
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: err.message }, 401, headers);
    }
    console.error("[upload-submission]", err);
    return json({ error: "Upload service failed." }, 500, headers);
  }
});

function mustEnv(name: string): string {
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

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: JsonRecord, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });
}

class AuthError extends Error {}

function bearerToken(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function requireUser(token: string): Promise<any> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new AuthError("Your sign-in session is no longer valid.");
  return data.user;
}

function githubUsernameFromUser(user: any): string {
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
  ).trim();
}

async function isApprovedUploader(usernameLower: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("approved_uploaders")
    .select("github_username")
    .eq("github_username", usernameLower)
    .eq("active", true)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

async function validateZip(file: File): Promise<string | null> {
  if (!/\.zip$/i.test(file.name)) return "File must end with .zip.";
  if (file.size <= 0) return "File is empty.";
  if (file.size > MAX_ZIP_BYTES) {
    return `File must be ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB or smaller.`;
  }
  const sig = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (sig.length < 4 || sig[0] !== 0x50 || sig[1] !== 0x4b) {
    return "File does not look like a zip archive.";
  }
  return null;
}

function makeRepoPath(usernameLower: string, originalName: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const safeName = originalName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "submission.zip";
  const shortId = crypto.randomUUID().slice(0, 8);
  return `staging/incoming/${timestamp}_${usernameLower}_${shortId}_${safeName}`;
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
    {
      iat: now - 60,
      exp: now + 540,
      iss: GITHUB_APP_ID,
    },
    privateKey(),
    { algorithm: "RS256" },
  );
}

async function resolveInstallationId(appJwt: string): Promise<string> {
  if (GITHUB_INSTALLATION_ID) return GITHUB_INSTALLATION_ID;

  const response = await githubFetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/installation`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${appJwt}` },
    },
  );
  const body = await response.json();
  if (!response.ok || !body.id) {
    throw new Error(`Could not resolve GitHub installation id: ${response.status}`);
  }
  return String(body.id);
}

async function createInstallationToken(): Promise<string> {
  const appJwt = await createAppJwt();
  const installationId = await resolveInstallationId(appJwt);

  const response = await githubFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${appJwt}` },
    },
  );
  const body = await response.json();
  if (!response.ok || !body.token) {
    throw new Error(`Could not create GitHub installation token: ${response.status}`);
  }
  return body.token;
}

async function createRepoFile(
  token: string,
  repoPath: string,
  content: string,
  usernameLower: string,
): Promise<{ sha: string; html_url: string }> {
  const response = await githubFetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(repoPath)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: `Upload submission from @${usernameLower}`,
        content,
        branch: GITHUB_BRANCH,
      }),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub upload failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return {
    sha: body.commit?.sha || "",
    html_url: body.commit?.html_url || "",
  };
}

async function dispatchWorkflow(token: string, repoPath: string): Promise<{ html_url: string }> {
  const response = await githubFetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${encodeURIComponent(GITHUB_WORKFLOW_ID)}/dispatches`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ref: GITHUB_BRANCH,
        inputs: { submission_path: repoPath },
      }),
    },
  );

  if (response.status === 204) return { html_url: "" };
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return { html_url: body.html_url || "" };
}

function githubFetch(url: string, init: RequestInit): Promise<Response> {
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

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function recordUpload(row: JsonRecord): Promise<void> {
  const { error } = await supabaseAdmin.from("submission_uploads").insert(row);
  if (error) console.warn("[upload-submission] upload audit failed", error);
}
