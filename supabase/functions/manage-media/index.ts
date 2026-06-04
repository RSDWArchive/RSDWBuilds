import {
  AuthError,
  GITHUB_BRANCH,
  GITHUB_OWNER,
  GITHUB_REPO,
  SITE_ASSETS_WORKFLOW_ID,
  arrayBufferToBase64,
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
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const THUMBNAIL_NAME = "thumbnail.webp";
const MAX_IMAGE_BYTES = Number(Deno.env.get("MAX_IMAGE_BYTES") || 8 * 1024 * 1024);

class RequestError extends Error {}

type GitHubContent = {
  name: string;
  path: string;
  type: "file" | "dir";
  sha: string;
  content?: string;
};

type GitRef = { object: { sha: string } };
type GitCommit = { sha: string; html_url?: string; tree: { sha: string } };
type GitBlob = { sha: string };
type GitTree = { sha: string };

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, headers);

  try {
    const manager = await requireManager(req);
    const form = await req.formData();
    const action = String(form.get("action") || "");
    if (action !== "update_images") throw new RequestError("Unknown media action.");

    const dataset = String(form.get("dataset") || "");
    const slug = String(form.get("slug") || "");
    const validation = validateDatasetSlug(dataset, slug);
    if (validation) throw new RequestError(validation);

    const order = parseOrder(String(form.get("order") || "[]"));
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    const token = await createInstallationToken();
    const result = await updateImages(token, manager.username, dataset, slug, order, files);
    return json(result, 200, headers);
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.message.includes("not approved") ? 403 : 401;
      return json({ error: err.message }, status, headers);
    }
    if (err instanceof RequestError) return json({ error: err.message }, 400, headers);
    console.error("[manage-media]", err);
    return json({ error: "Media management failed." }, 500, headers);
  }
});

function validateDatasetSlug(dataset: string, slug: string): string {
  if (!DATASETS.has(dataset)) return "Invalid dataset.";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) return "Invalid slug.";
  return "";
}

function parseOrder(raw: string): Array<{ type: string; name?: string; index?: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    throw new RequestError("Photo order must be valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new RequestError("Photo order must be a list.");
  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new RequestError("Photo order has an invalid item.");
    const row = item as Record<string, unknown>;
    const type = String(row.type || "");
    if (type === "existing") return { type, name: String(row.name || "") };
    if (type === "new") return { type, index: Number(row.index) };
    throw new RequestError("Photo order has an unknown item type.");
  });
}

function decodeContent(file: GitHubContent): string {
  return new TextDecoder().decode(Uint8Array.from(atob((file.content || "").replace(/\s/g, "")), (c) => c.charCodeAt(0)));
}

async function getContent(token: string, path: string): Promise<GitHubContent> {
  return await githubJson<GitHubContent>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
  );
}

async function readJsonFile(token: string, path: string): Promise<{ data: any; sha: string }> {
  const file = await getContent(token, path);
  return { data: JSON.parse(decodeContent(file)), sha: file.sha };
}

async function listFolder(token: string, path: string): Promise<GitHubContent[]> {
  return await githubJson<GitHubContent[]>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
  );
}

function cleanImages(data: any): string[] {
  const out: string[] = [];
  if (Array.isArray(data.images)) {
    for (const item of data.images) {
      if (typeof item === "string" && isSafeRel(item) && item !== THUMBNAIL_NAME && !out.includes(item)) out.push(item);
    }
  }
  if (!out.length && typeof data.image === "string" && isSafeRel(data.image) && data.image !== THUMBNAIL_NAME) {
    out.push(data.image);
  }
  return out;
}

function isSafeRel(name: string): boolean {
  return !!name && !name.startsWith("/") && !name.includes("\\") && !name.split("/").includes("..");
}

function extname(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function validateImageFile(file: File): void {
  if (file.size <= 0) throw new RequestError(`${file.name} is empty.`);
  if (file.size > MAX_IMAGE_BYTES) throw new RequestError(`${file.name} must be ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB or smaller.`);
  if (!IMAGE_EXTS.has(extname(file.name))) throw new RequestError(`${file.name} is not a supported image type.`);
}

function sanitizeImageName(name: string): string {
  const leaf = name.replace(/\\/g, "/").split("/").pop() || "image";
  const ext = extname(leaf);
  const stem = leaf.slice(0, leaf.length - ext.length)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "image";
  let candidate = `${stem}${ext}`;
  if (candidate === THUMBNAIL_NAME || candidate === "build.json") candidate = `photo_${candidate}`;
  return candidate;
}

function uniqueName(candidate: string, reserved: Set<string>): string {
  if (!reserved.has(candidate)) {
    reserved.add(candidate);
    return candidate;
  }
  const ext = extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  let n = 2;
  while (reserved.has(`${stem}_${n}${ext}`)) n += 1;
  const out = `${stem}_${n}${ext}`;
  reserved.add(out);
  return out;
}

async function createBlob(token: string, content: string, encoding: "utf-8" | "base64"): Promise<string> {
  const blob = await githubJson<GitBlob>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`,
    {
      method: "POST",
      body: JSON.stringify({ content, encoding }),
    },
  );
  return blob.sha;
}

function textToBase64(text: string): string {
  return arrayBufferToBase64(new TextEncoder().encode(text).buffer);
}

async function commitTree(token: string, message: string, treeEntries: any[]): Promise<GitCommit> {
  const ref = await githubJson<GitRef>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${GITHUB_BRANCH}`,
  );
  const head = await githubJson<GitCommit>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${ref.object.sha}`,
  );
  const tree = await githubJson<GitTree>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({ base_tree: head.tree.sha, tree: treeEntries }),
    },
  );
  const commit = await githubJson<GitCommit>(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
    },
  );
  await githubJson(
    token,
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${GITHUB_BRANCH}`,
    {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false }),
    },
  );
  return commit;
}

async function updateImages(
  token: string,
  username: string,
  dataset: string,
  slug: string,
  order: Array<{ type: string; name?: string; index?: number }>,
  files: File[],
): Promise<any> {
  files.forEach(validateImageFile);
  const entryRoot = `website/data/${dataset}/${slug}`;
  const current = await readJsonFile(token, `${entryRoot}/build.json`);
  const currentImages = cleanImages(current.data);
  const currentSet = new Set(currentImages);
  const folderFiles = await listFolder(token, entryRoot);
  const reserved = new Set(folderFiles.map((item) => item.name));

  const newNames = files.map((file) => uniqueName(sanitizeImageName(file.name), reserved));
  const usedExisting = new Set<string>();
  const usedNew = new Set<number>();
  const finalImages: string[] = [];

  if (!order.length) {
    order = currentImages.map((name) => ({ type: "existing", name }));
    files.forEach((_file, index) => order.push({ type: "new", index }));
  }

  for (const item of order) {
    if (item.type === "existing") {
      const name = String(item.name || "");
      if (!isSafeRel(name) || name === THUMBNAIL_NAME) throw new RequestError(`Invalid existing image: ${name}`);
      if (!currentSet.has(name)) throw new RequestError(`Photo is not part of this entry: ${name}`);
      if (usedExisting.has(name)) throw new RequestError(`Photo appears more than once: ${name}`);
      usedExisting.add(name);
      finalImages.push(name);
    } else if (item.type === "new") {
      const index = Number(item.index);
      if (!Number.isInteger(index) || index < 0 || index >= files.length) throw new RequestError("New photo order references a missing file.");
      if (usedNew.has(index)) throw new RequestError("New photo appears more than once.");
      usedNew.add(index);
      finalImages.push(newNames[index]);
    }
  }

  files.forEach((_file, index) => {
    if (!usedNew.has(index)) finalImages.push(newNames[index]);
  });

  if (!finalImages.length) throw new RequestError("At least one photo is required.");
  const deleteNames = currentImages.filter((name) => !usedExisting.has(name));
  const next = { ...current.data, image: THUMBNAIL_NAME, images: finalImages, updated_unix: Math.floor(Date.now() / 1000) };
  const nextJson = JSON.stringify(next, null, 2) + "\n";
  const currentJson = JSON.stringify(current.data, null, 2) + "\n";

  if (!files.length && !deleteNames.length && nextJson === currentJson) {
    return { ok: true, unchanged: true };
  }

  const treeEntries = [];
  for (let i = 0; i < files.length; i += 1) {
    treeEntries.push({
      path: `${entryRoot}/${newNames[i]}`,
      mode: "100644",
      type: "blob",
      sha: await createBlob(token, arrayBufferToBase64(await files[i].arrayBuffer()), "base64"),
    });
  }
  for (const name of deleteNames) {
    treeEntries.push({ path: `${entryRoot}/${name}`, mode: "100644", type: "blob", sha: null });
  }
  treeEntries.push({
    path: `${entryRoot}/build.json`,
    mode: "100644",
    type: "blob",
    sha: await createBlob(token, textToBase64(nextJson), "base64"),
  });

  const commit = await commitTree(token, `Update ${dataset}/${slug} photos`, treeEntries);
  await dispatchWorkflow(token, SITE_ASSETS_WORKFLOW_ID);
  await recordManagementAction({
    github_username: username,
    action: "update_images",
    dataset,
    slug,
    payload: { images: finalImages, added: newNames, deleted: deleteNames },
    commit_sha: commit.sha,
    commit_url: commit.html_url || "",
  });
  return {
    ok: true,
    images: finalImages,
    added: newNames,
    deleted: deleteNames,
    commit_sha: commit.sha,
    commit_html_url: commit.html_url || "",
  };
}
