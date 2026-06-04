import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

(function () {
  "use strict";

  var SUPABASE_URL = "https://xvhcniquixigesgqojdk.supabase.co";
  var SUPABASE_KEY = "sb_publishable_Z-ZdcdkLG6T0Kp9VQTGV3Q_yACgE2tI";
  var ADMIN_URL = SUPABASE_URL + "/functions/v1/admin-users";
  var USERNAME_RE = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/;

  var supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: true, detectSessionInUrl: true, persistSession: true },
  });

  var state = { session: null, users: [], query: "" };
  var els = {};

  function $(id) { return document.getElementById(id); }

  function meta(user) {
    var m = (user && user.user_metadata) || {};
    return {
      name: m.full_name || m.name || m.user_name || m.preferred_username || "GitHub user",
      username: m.user_name || m.preferred_username || m.login || "",
      avatar: m.avatar_url || m.picture || "",
    };
  }

  function normalizeUsername(value) {
    return String(value || "").trim().replace(/^@+/, "").toLowerCase();
  }

  function setStatus(kind, text) {
    els.status.hidden = !text;
    els.status.className = "rsdw-upload__status";
    if (kind) els.status.classList.add("is-" + kind);
    els.status.textContent = text || "";
  }

  function authHeaders() {
    return { apikey: SUPABASE_KEY, Authorization: "Bearer " + state.session.access_token };
  }

  function apiJson(body) {
    return fetch(ADMIN_URL, {
      method: body ? "POST" : "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (json) {
        if (!response.ok) throw new Error(json.error || ("HTTP " + response.status));
        return json;
      });
    });
  }

  function login() {
    supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: window.location.origin + "/admin/" },
    });
  }

  function logout() {
    supabase.auth.signOut();
    state.users = [];
    renderUsers();
    setStatus("", "");
  }

  function renderAuth(session) {
    state.session = session;
    var signedIn = !!(session && session.user);
    els.signedOut.hidden = signedIn;
    els.signedIn.hidden = !signedIn;
    els.panel.hidden = !signedIn;
    if (!signedIn) return;

    var m = meta(session.user);
    els.name.textContent = m.name;
    els.username.textContent = m.username ? "@" + m.username : "";
    if (m.avatar) els.avatar.src = m.avatar;
    loadUsers();
  }

  function loadUsers() {
    els.list.textContent = "Loading...";
    apiJson()
      .then(function (data) {
        state.users = data.users || [];
        renderUsers();
        setStatus("", "");
      })
      .catch(function (err) {
        els.panel.hidden = true;
        els.list.textContent = "";
        setStatus("error", err.message);
      });
  }

  function filteredUsers() {
    var q = state.query.trim().toLowerCase();
    if (!q) return state.users.slice();
    return state.users.filter(function (user) {
      return user.github_username.indexOf(q) >= 0;
    });
  }

  function roleCheck(user, field, label) {
    var wrap = document.createElement("label");
    wrap.className = "rsdw-admin__check";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!user[field];
    input.dataset.role = field;
    var span = document.createElement("span");
    span.textContent = label;
    wrap.appendChild(input);
    wrap.appendChild(span);
    return wrap;
  }

  function activeBadge(user) {
    var badge = document.createElement("span");
    var active = !!(user.uploader || user.manager);
    badge.className = "rsdw-admin__badge" + (active ? " is-active" : "");
    badge.textContent = active ? "Active" : "Inactive";
    return badge;
  }

  function renderUsers() {
    els.list.replaceChildren();
    var users = filteredUsers();
    if (!users.length) {
      els.list.textContent = "No users.";
      return;
    }
    users.forEach(function (user) {
      var row = document.createElement("div");
      row.className = "rsdw-admin__row";
      row.dataset.username = user.github_username;

      var name = document.createElement("div");
      name.className = "rsdw-admin__user";
      var strong = document.createElement("strong");
      strong.textContent = "@" + user.github_username;
      var updated = document.createElement("span");
      updated.textContent = user.updated_at ? "Updated " + new Date(user.updated_at).toLocaleString() : "";
      name.appendChild(strong);
      name.appendChild(updated);

      var actions = document.createElement("div");
      actions.className = "rsdw-admin__row-actions";
      var save = document.createElement("button");
      save.type = "button";
      save.className = "rsdw-btn";
      save.textContent = "Save";
      save.addEventListener("click", function () {
        saveUser(row, user.github_username);
      });
      actions.appendChild(save);

      row.appendChild(name);
      row.appendChild(roleCheck(user, "uploader", "Upload"));
      row.appendChild(roleCheck(user, "manager", "Manage"));
      row.appendChild(actions);
      row.appendChild(activeBadge(user));
      els.list.appendChild(row);
    });
  }

  function roleStateFromRow(row) {
    return {
      uploader: !!row.querySelector('input[data-role="uploader"]').checked,
      manager: !!row.querySelector('input[data-role="manager"]').checked,
    };
  }

  function saveUser(row, username) {
    var roles = roleStateFromRow(row);
    setStatus("", "Saving @" + username + "...");
    apiJson({
      github_username: username,
      uploader: roles.uploader,
      manager: roles.manager,
    }).then(function () {
      setStatus("ok", "Saved @" + username + ".");
      loadUsers();
    }).catch(function (err) {
      setStatus("error", err.message);
    });
  }

  function addUser() {
    var username = normalizeUsername(els.newUsername.value);
    var uploader = els.newUploader.checked;
    var manager = els.newManager.checked;
    if (!USERNAME_RE.test(username)) {
      setStatus("error", "Enter a valid GitHub username.");
      return;
    }
    if (!uploader && !manager) {
      setStatus("error", "Choose at least one permission for a new user.");
      return;
    }
    setStatus("", "Adding @" + username + "...");
    apiJson({ github_username: username, uploader: uploader, manager: manager })
      .then(function () {
        els.newUsername.value = "";
        els.newUploader.checked = true;
        els.newManager.checked = false;
        setStatus("ok", "Added @" + username + ".");
        loadUsers();
      })
      .catch(function (err) {
        setStatus("error", err.message);
      });
  }

  function init() {
    els.signedOut = $("rsdw-admin-signed-out");
    els.signedIn = $("rsdw-admin-signed-in");
    els.login = $("rsdw-admin-login");
    els.logout = $("rsdw-admin-logout");
    els.avatar = $("rsdw-admin-avatar");
    els.name = $("rsdw-admin-name");
    els.username = $("rsdw-admin-username");
    els.panel = $("rsdw-admin-panel");
    els.newUsername = $("rsdw-admin-new-username");
    els.newUploader = $("rsdw-admin-new-uploader");
    els.newManager = $("rsdw-admin-new-manager");
    els.addUser = $("rsdw-admin-add-user");
    els.search = $("rsdw-admin-search");
    els.refresh = $("rsdw-admin-refresh");
    els.list = $("rsdw-admin-users");
    els.status = $("rsdw-admin-status");

    els.login.addEventListener("click", login);
    els.logout.addEventListener("click", logout);
    els.addUser.addEventListener("click", addUser);
    els.refresh.addEventListener("click", loadUsers);
    els.search.addEventListener("input", function () {
      state.query = els.search.value;
      renderUsers();
    });
    els.newUsername.addEventListener("keydown", function (event) {
      if (event.key === "Enter") addUser();
    });

    supabase.auth.getSession().then(function (result) {
      renderAuth(result.data && result.data.session);
    });
    supabase.auth.onAuthStateChange(function (_event, session) {
      renderAuth(session);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
