import {
  AuthError,
  GITHUB_BRANCH,
  GITHUB_OWNER,
  GITHUB_REPO,
  REPLACE_WORKFLOW_ID,
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
const MAX_ZIP_BYTES = Number(Deno.env.get("MAX_ZIP_BYTES") || 25 * 1024 * 1024);

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, headers);

  try {
    const manager = await requireManager(req);
    const form = await req.formData();
    const dataset = String(form.get("dataset") || "");
    const slug = String(form.get("slug") || "");
    const file = form.get("file");
    const validation = validate(dataset, slug, file);
    if (validation) return json({ error: validation }, 400, headers);

    const zip = file as File;
    const path = makeRepoPath(dataset, slug, manager.username, zip.name);
    const token = await createInstallationToken();
    const upload = await githubJson<any>(token, `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Queue replacement for ${dataset}/${slug} from @${manager.username}`,
        content: arrayBufferToBase64(await zip.arrayBuffer()),
        branch: GITHUB_BRANCH,
      }),
    });
    await dispatchWorkflow(token, REPLACE_WORKFLOW_ID, { replacement_path: path, dataset, slug });
    await recordManagementAction({
      github_username: manager.username,
      action: "queue_replacement",
      dataset,
      slug,
      payload: { path, original_filename: zip.name, file_size_bytes: zip.size },
      commit_sha: upload.commit?.sha || "",
      commit_url: upload.commit?.html_url || "",
    });
    return json({
      ok: true,
      path,
      commit_sha: upload.commit?.sha || "",
      commit_html_url: upload.commit?.html_url || "",
    }, 200, headers);
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.message.includes("not approved") ? 403 : 401;
      return json({ error: err.message }, status, headers);
    }
    console.error("[replace-entry]", err);
    return json({ error: "Replacement service failed." }, 500, headers);
  }
});

function validate(dataset: string, slug: string, file: FormDataEntryValue | null): string {
  if (!DATASETS.has(dataset)) return "Invalid dataset.";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) return "Invalid slug.";
  if (!(file instanceof File)) return "Missing file field.";
  if (!/\.zip$/i.test(file.name)) return "File must end with .zip.";
  if (file.size <= 0) return "File is empty.";
  if (file.size > MAX_ZIP_BYTES) return `File must be ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB or smaller.`;
  return "";
}

function makeRepoPath(dataset: string, slug: string, username: string, originalName: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeName = originalName.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "replacement.zip";
  const shortId = crypto.randomUUID().slice(0, 8);
  return `staging/management/replacements/${timestamp}_${dataset}_${slug}_${username}_${shortId}_${safeName}`;
}
