import {
  AuthError,
  GITHUB_BRANCH,
  GITHUB_OWNER,
  GITHUB_REPO,
  SITE_ASSETS_WORKFLOW_ID,
  corsHeaders,
  createInstallationToken,
  dispatchWorkflow,
  encodePath,
  githubJson,
  json,
  recordManagementAction,
  requireManager,
} from "../_shared/common.ts";

const DATASETS = new Set(["builds", "prefabs"]);
const METADATA_FIELDS = new Set(["name", "description", "authors", "tags", "youtube", "nexusmods"]);

class RequestError extends Error {}

type GitHubContent = {
  name: string;
  path: string;
  type: "file" | "dir";
  sha: string;
  content?: string;
  encoding?: string;
  html_url?: string;
};

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });

  try {
    const manager = await requireManager(req);
    const token = await createInstallationToken();

    if (req.method === "GET") {
      const url = new URL(req.url);
      const dataset = url.searchParams.get("dataset") || "";
      if (dataset && !DATASETS.has(dataset)) return json({ error: "Invalid dataset." }, 400, headers);
      const datasets = dataset ? [dataset] : Array.from(DATASETS);
      const entries = [];
      for (const ds of datasets) entries.push(...await listEntries(token, ds));
      return json({ entries }, 200, headers);
    }

    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, headers);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid request body." }, 400, headers);

    const action = String(body.action || "");
    const dataset = String(body.dataset || "");
    const slug = String(body.slug || "");
    const validation = validateDatasetSlug(dataset, slug);
    if (validation) return json({ error: validation }, 400, headers);

    if (action === "update_metadata") {
      const result = await updateMetadata(token, manager.username, dataset, slug, body.fields || {});
      return json(result, 200, headers);
    }
    if (action === "set_visibility") {
      const visible = !!body.visible;
      const result = await setVisibility(token, manager.username, dataset, slug, visible);
      return json(result, 200, headers);
    }
    return json({ error: "Unknown action." }, 400, headers);
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.message.includes("not approved") ? 403 : 401;
      return json({ error: err.message }, status, headers);
    }
    if (err instanceof RequestError) return json({ error: err.message }, 400, headers);
    console.error("[manage-entries]", err);
    return json({ error: "Management service failed." }, 500, headers);
  }
});

function validateDatasetSlug(dataset: string, slug: string): string {
  if (!DATASETS.has(dataset)) return "Invalid dataset.";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) return "Invalid slug.";
  return "";
}

function decodeContent(file: GitHubContent): string {
  return new TextDecoder().decode(Uint8Array.from(atob((file.content || "").replace(/\s/g, "")), (c) => c.charCodeAt(0)));
}

function encodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function getContent(token: string, path: string): Promise<GitHubContent> {
  return await githubJson<GitHubContent>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
  );
}

async function putContent(
  token: string,
  path: string,
  contentText: string,
  sha: string,
  message: string,
): Promise<{ commit: { sha: string; html_url: string } }> {
  return await githubJson(token, `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: encodeText(contentText),
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
}

async function readJsonFile(token: string, path: string): Promise<{ data: any; sha: string; html_url?: string }> {
  const file = await getContent(token, path);
  return { data: JSON.parse(decodeContent(file)), sha: file.sha, html_url: file.html_url };
}

async function listEntries(token: string, dataset: string): Promise<any[]> {
  const index = await readJsonFile(token, `website/data/${dataset}/index.json`);
  const visible = new Set((index.data.entries || index.data[dataset] || []).map(String));
  const dirs = await githubJson<GitHubContent[]>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(`website/data/${dataset}`)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
  );
  const entries = [];
  for (const dir of dirs.filter((item) => item.type === "dir")) {
    try {
      const card = await readJsonFile(token, `website/data/${dataset}/${dir.name}/build.json`);
      entries.push({
        dataset,
        slug: dir.name,
        visible: visible.has(dir.name),
        data: card.data,
      });
    } catch (_err) {
      entries.push({ dataset, slug: dir.name, visible: visible.has(dir.name), data: null });
    }
  }
  entries.sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return String(a.data?.name || a.slug).localeCompare(String(b.data?.name || b.slug));
  });
  return entries;
}

function cleanMetadata(input: any): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new RequestError("Missing metadata fields.");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!METADATA_FIELDS.has(key)) continue;
    const value = input[key];
    if (key === "name") {
      if (typeof value !== "string" || !value.trim()) throw new RequestError("Name is required.");
      out.name = value.trim();
    } else if (key === "description") {
      if (typeof value !== "string") throw new RequestError("Description must be text.");
      out.description = value.trim();
    } else if (key === "authors" || key === "tags") {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim())) {
        throw new RequestError(`${key} must be a list of text values.`);
      }
      out[key] = value.map((v) => String(v).trim());
    } else if (key === "youtube" || key === "nexusmods") {
      if (value == null || String(value).trim() === "") {
        out[key] = "";
      } else {
        let url: URL;
        try {
          url = new URL(String(value));
        } catch (_err) {
          throw new RequestError(`${key} must be an http(s) URL.`);
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new RequestError(`${key} must be an http(s) URL.`);
        out[key] = String(value).trim();
      }
    }
  }
  if (Object.keys(out).length === 0) throw new RequestError("No editable metadata fields were provided.");
  return out;
}

async function updateMetadata(token: string, username: string, dataset: string, slug: string, fields: any): Promise<any> {
  const clean = cleanMetadata(fields);
  const path = `website/data/${dataset}/${slug}/build.json`;
  const current = await readJsonFile(token, path);
  const next = { ...current.data };
  for (const [key, value] of Object.entries(clean)) {
    if ((key === "youtube" || key === "nexusmods") && value === "") delete next[key];
    else next[key] = value;
  }
  if (JSON.stringify(next) === JSON.stringify(current.data)) {
    return { ok: true, unchanged: true };
  }
  const upload = await putContent(token, path, JSON.stringify(next, null, 2) + "\n", current.sha, `Update ${dataset}/${slug} metadata`);
  await dispatchWorkflow(token, SITE_ASSETS_WORKFLOW_ID);
  await recordManagementAction({
    github_username: username,
    action: "update_metadata",
    dataset,
    slug,
    payload: { fields: Object.keys(clean) },
    commit_sha: upload.commit?.sha || "",
    commit_url: upload.commit?.html_url || "",
  });
  return { ok: true, commit_sha: upload.commit?.sha || "", commit_html_url: upload.commit?.html_url || "" };
}

async function setVisibility(token: string, username: string, dataset: string, slug: string, visible: boolean): Promise<any> {
  await readJsonFile(token, `website/data/${dataset}/${slug}/build.json`);
  const indexPath = `website/data/${dataset}/index.json`;
  const index = await readJsonFile(token, indexPath);
  let entries = (index.data.entries || index.data[dataset] || []).map(String);
  const had = entries.includes(slug);
  if (visible && !had) entries.push(slug);
  if (!visible && had) entries = entries.filter((entry) => entry !== slug);
  if (visible) entries = await sortSlugsByPublished(token, dataset, entries);
  const next = { entries };
  if (JSON.stringify(next) === JSON.stringify(index.data)) {
    return { ok: true, visible, unchanged: true };
  }
  const upload = await putContent(token, indexPath, JSON.stringify(next, null, 2) + "\n", index.sha, `${visible ? "Show" : "Hide"} ${dataset}/${slug}`);
  await dispatchWorkflow(token, SITE_ASSETS_WORKFLOW_ID);
  await recordManagementAction({
    github_username: username,
    action: visible ? "unhide" : "hide",
    dataset,
    slug,
    payload: { visible },
    commit_sha: upload.commit?.sha || "",
    commit_url: upload.commit?.html_url || "",
  });
  return { ok: true, visible, commit_sha: upload.commit?.sha || "", commit_html_url: upload.commit?.html_url || "" };
}

async function sortSlugsByPublished(token: string, dataset: string, slugs: string[]): Promise<string[]> {
  const unique = Array.from(new Set(slugs));
  const rows = [];
  for (const slug of unique) {
    try {
      const card = await readJsonFile(token, `website/data/${dataset}/${slug}/build.json`);
      rows.push({ slug, ts: Number(card.data.published_unix || 0) || 0 });
    } catch (_err) {
      rows.push({ slug, ts: 0 });
    }
  }
  rows.sort((a, b) => (b.ts - a.ts) || a.slug.localeCompare(b.slug));
  return rows.map((row) => row.slug);
}
