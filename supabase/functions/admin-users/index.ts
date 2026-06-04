import {
  AuthError,
  corsHeaders,
  json,
  recordAdminAction,
  requireAdmin,
  supabaseAdmin,
} from "../_shared/common.ts";

const USERNAME_RE = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/;

class RequestError extends Error {}

type RoleRow = {
  github_username: string;
  active: boolean;
  note?: string | null;
  created_at?: string;
  updated_at?: string;
};

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });

  try {
    const admin = await requireAdmin(req);

    if (req.method === "GET") {
      return json({ users: await listUsers(), admin: admin.username }, 200, headers);
    }

    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, headers);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new RequestError("Invalid request body.");

    const username = normalizeUsername(String(body.github_username || body.username || ""));
    const uploader = parseBoolean(body.uploader, "uploader");
    const manager = parseBoolean(body.manager, "manager");
    const note = cleanNote(body.note);
    const result = await setRoles(admin.username, username, uploader, manager, note);
    return json(result, 200, headers);
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.message.includes("not approved") ? 403 : 401;
      return json({ error: err.message }, status, headers);
    }
    if (err instanceof RequestError) return json({ error: err.message }, 400, headers);
    console.error("[admin-users]", err);
    return json({ error: "Admin service failed." }, 500, headers);
  }
});

function normalizeUsername(input: string): string {
  const username = input.trim().replace(/^@+/, "").toLowerCase();
  if (!USERNAME_RE.test(username)) throw new RequestError("Enter a valid GitHub username.");
  return username;
}

function cleanNote(value: unknown): string {
  if (value == null) return "admin managed";
  const note = String(value).trim();
  if (note.length > 160) throw new RequestError("Note must be 160 characters or fewer.");
  return note || "admin managed";
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new RequestError(`${field} must be true or false.`);
  return value;
}

async function fetchRoleRows(table: "approved_uploaders" | "approved_managers"): Promise<RoleRow[]> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select("github_username, active, note, created_at, updated_at")
    .order("github_username", { ascending: true });
  if (error) throw error;
  return (data || []) as RoleRow[];
}

async function listUsers(): Promise<any[]> {
  const [uploaders, managers] = await Promise.all([
    fetchRoleRows("approved_uploaders"),
    fetchRoleRows("approved_managers"),
  ]);
  const byName = new Map<string, any>();

  function ensure(username: string): any {
    if (!byName.has(username)) {
      byName.set(username, {
        github_username: username,
        uploader: false,
        manager: false,
        uploader_note: "",
        manager_note: "",
        updated_at: "",
      });
    }
    return byName.get(username);
  }

  uploaders.forEach((row) => {
    const user = ensure(row.github_username);
    user.uploader = !!row.active;
    user.uploader_note = row.note || "";
    user.updated_at = maxIso(user.updated_at, row.updated_at || row.created_at || "");
  });
  managers.forEach((row) => {
    const user = ensure(row.github_username);
    user.manager = !!row.active;
    user.manager_note = row.note || "";
    user.updated_at = maxIso(user.updated_at, row.updated_at || row.created_at || "");
  });

  return Array.from(byName.values()).sort((a, b) => {
    if ((a.uploader || a.manager) !== (b.uploader || b.manager)) return (a.uploader || a.manager) ? -1 : 1;
    return a.github_username.localeCompare(b.github_username);
  });
}

function maxIso(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

async function setRole(
  table: "approved_uploaders" | "approved_managers",
  username: string,
  active: boolean,
  note: string,
): Promise<void> {
  if (active) {
    const { error } = await supabaseAdmin
      .from(table)
      .upsert({
        github_username: username,
        active: true,
        note,
        updated_at: new Date().toISOString(),
      }, { onConflict: "github_username" });
    if (error) throw error;
    return;
  }

  const { error } = await supabaseAdmin
    .from(table)
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("github_username", username);
  if (error) throw error;
}

async function setRoles(adminUsername: string, username: string, uploader: boolean, manager: boolean, note: string): Promise<any> {
  const before = (await listUsers()).find((user) => user.github_username === username) || {
    github_username: username,
    uploader: false,
    manager: false,
  };

  await setRole("approved_uploaders", username, uploader, note);
  await setRole("approved_managers", username, manager, note);

  const after = (await listUsers()).find((user) => user.github_username === username) || {
    github_username: username,
    uploader: false,
    manager: false,
  };

  await recordAdminAction({
    admin_username: adminUsername,
    target_username: username,
    action: "set_staff_roles",
    payload: {
      before: { uploader: !!before.uploader, manager: !!before.manager },
      after: { uploader: !!after.uploader, manager: !!after.manager },
    },
  });

  return { ok: true, user: after };
}
