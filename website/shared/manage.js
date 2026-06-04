import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

(function () {
  "use strict";

  var SUPABASE_URL = "https://xvhcniquixigesgqojdk.supabase.co";
  var SUPABASE_KEY = "sb_publishable_Z-ZdcdkLG6T0Kp9VQTGV3Q_yACgE2tI";
  var MANAGE_URL = SUPABASE_URL + "/functions/v1/manage-entries";
  var REPLACE_URL = SUPABASE_URL + "/functions/v1/replace-entry";
  var MAX_ZIP_BYTES = 25 * 1024 * 1024;

  var supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: true, detectSessionInUrl: true, persistSession: true },
  });

  var state = { session: null, entries: [], dataset: "builds", query: "", selected: null, file: null };
  var els = {};

  function $(id) { return document.getElementById(id); }
  function folder(entry) { return "/data/" + entry.dataset + "/" + entry.slug; }
  function join(entry, rel) { return rel && rel.startsWith("/") ? rel : folder(entry) + "/" + rel; }
  function fmtSize(bytes) { return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1024 / 1024).toFixed(2) + " MB"; }

  function meta(user) {
    var m = (user && user.user_metadata) || {};
    return {
      name: m.full_name || m.name || m.user_name || m.preferred_username || "GitHub user",
      username: m.user_name || m.preferred_username || m.login || "",
      avatar: m.avatar_url || m.picture || "",
    };
  }

  function setStatus(kind, text) {
    els.status.hidden = !text;
    els.status.className = "rsdw-upload__status";
    if (kind) els.status.classList.add("is-" + kind);
    els.status.textContent = text || "";
  }

  function setIssues(messages) {
    els.issues.hidden = !messages.length;
    els.issues.replaceChildren();
    if (!messages.length) return;
    var ul = document.createElement("ul");
    messages.forEach(function (msg) {
      var li = document.createElement("li");
      li.textContent = msg;
      ul.appendChild(li);
    });
    els.issues.appendChild(ul);
  }

  function authHeaders() {
    return { apikey: SUPABASE_KEY, Authorization: "Bearer " + state.session.access_token };
  }

  function apiJson(url, body) {
    return fetch(url, {
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
    loadEntries();
  }

  function login() {
    supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: window.location.origin + "/manage/" },
    });
  }

  function logout() {
    supabase.auth.signOut();
    state.entries = [];
    state.selected = null;
    state.file = null;
    renderList();
    els.editor.hidden = true;
  }

  function loadEntries() {
    els.list.textContent = "Loading...";
    apiJson(MANAGE_URL)
      .then(function (data) {
        state.entries = data.entries || [];
        if (!state.selected && state.entries.length) state.selected = state.entries[0];
        renderList();
        renderEditor();
      })
      .catch(function (err) {
        els.list.textContent = "";
        els.panel.hidden = true;
        setStatus("error", err.message);
      });
  }

  function filteredEntries() {
    var q = state.query.trim().toLowerCase();
    return state.entries.filter(function (entry) {
      if (entry.dataset !== state.dataset) return false;
      if (!q) return true;
      var data = entry.data || {};
      return [entry.slug, data.name, data.description].concat(data.authors || [], data.tags || [])
        .join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderList() {
    els.list.replaceChildren();
    var entries = filteredEntries();
    if (!entries.length) {
      els.list.textContent = "No entries.";
      return;
    }
    entries.forEach(function (entry) {
      var data = entry.data || {};
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rsdw-manage__entry";
      if (state.selected && entry.dataset === state.selected.dataset && entry.slug === state.selected.slug) {
        btn.classList.add("is-active");
      }
      btn.addEventListener("click", function () {
        state.selected = entry;
        state.file = null;
        renderList();
        renderEditor();
      });
      var img = document.createElement("img");
      img.alt = "";
      img.src = data.image ? join(entry, data.image) : "/shared/assets/logo.png";
      var text = document.createElement("div");
      var strong = document.createElement("strong");
      strong.textContent = data.name || entry.slug;
      var slug = document.createElement("span");
      slug.textContent = entry.slug;
      text.appendChild(strong);
      text.appendChild(slug);
      var badge = document.createElement("span");
      badge.className = "rsdw-manage__badge" + (entry.visible ? " is-visible" : "");
      badge.textContent = entry.visible ? "Visible" : "Hidden";
      btn.appendChild(img);
      btn.appendChild(text);
      btn.appendChild(badge);
      els.list.appendChild(btn);
    });
  }

  function renderEditor() {
    var entry = state.selected;
    if (!entry) {
      els.editor.hidden = true;
      return;
    }
    var data = entry.data || {};
    els.editor.hidden = false;
    els.title.textContent = data.name || entry.slug;
    els.slug.textContent = entry.dataset + "/" + entry.slug;
    els.view.href = "/" + entry.dataset + "/" + entry.slug + "/";
    els.nameField.value = data.name || "";
    els.authors.value = (data.authors || []).join(", ");
    els.description.value = data.description || "";
    els.tags.value = (data.tags || []).join(", ");
    els.youtube.value = data.youtube || "";
    els.nexusmods.value = data.nexusmods || "";
    els.visibility.textContent = entry.visible ? "Hide" : "Unhide";
    renderFile();
    setIssues([]);
    setStatus("", "");
  }

  function splitList(value) {
    return value.split(",").map(function (part) { return part.trim(); }).filter(Boolean);
  }

  function validateMetadata() {
    var issues = [];
    if (!els.nameField.value.trim()) issues.push("Name is required.");
    if (!splitList(els.authors.value).length) issues.push("At least one author is required.");
    return issues;
  }

  function saveMetadata() {
    var issues = validateMetadata();
    setIssues(issues);
    if (issues.length || !state.selected) return;
    setStatus("", "Saving...");
    apiJson(MANAGE_URL, {
      action: "update_metadata",
      dataset: state.selected.dataset,
      slug: state.selected.slug,
      fields: {
        name: els.nameField.value,
        authors: splitList(els.authors.value),
        description: els.description.value,
        tags: splitList(els.tags.value),
        youtube: els.youtube.value,
        nexusmods: els.nexusmods.value,
      },
    }).then(function () {
      setStatus("ok", "Metadata saved. Pages deploy will run shortly.");
      loadEntries();
    }).catch(function (err) {
      setStatus("error", err.message);
    });
  }

  function toggleVisibility() {
    if (!state.selected) return;
    var next = !state.selected.visible;
    setStatus("", next ? "Unhiding..." : "Hiding...");
    apiJson(MANAGE_URL, {
      action: "set_visibility",
      dataset: state.selected.dataset,
      slug: state.selected.slug,
      visible: next,
    }).then(function () {
      setStatus("ok", next ? "Entry visible. Pages deploy will run shortly." : "Entry hidden. Pages deploy will run shortly.");
      state.selected.visible = next;
      loadEntries();
    }).catch(function (err) {
      setStatus("error", err.message);
    });
  }

  function bindTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".rsdw-manage__tabs button"), function (btn) {
      btn.addEventListener("click", function () {
        state.dataset = btn.dataset.dataset;
        Array.prototype.forEach.call(document.querySelectorAll(".rsdw-manage__tabs button"), function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        var next = filteredEntries()[0] || null;
        state.selected = next;
        renderList();
        renderEditor();
      });
    });
  }

  function acceptFile(files) {
    state.file = files && files[0] ? files[0] : null;
    renderFile();
  }

  function renderFile() {
    els.fileList.replaceChildren();
    els.replace.disabled = true;
    if (!state.file) return;
    var li = document.createElement("li");
    var name = document.createElement("span");
    name.className = "rsdw-filelist__name";
    name.textContent = state.file.name;
    var size = document.createElement("span");
    size.className = "rsdw-filelist__size";
    size.textContent = fmtSize(state.file.size);
    li.appendChild(name);
    li.appendChild(size);
    els.fileList.appendChild(li);
    els.replace.disabled = !/\.zip$/i.test(state.file.name) || state.file.size <= 0 || state.file.size > MAX_ZIP_BYTES;
  }

  function bindDropzone() {
    els.pick.addEventListener("click", function () { els.file.click(); });
    els.drop.addEventListener("click", function (e) { if (e.target !== els.pick) els.file.click(); });
    els.file.addEventListener("change", function () { acceptFile(els.file.files); });
    ["dragenter", "dragover"].forEach(function (eventName) {
      els.drop.addEventListener(eventName, function (e) {
        e.preventDefault();
        els.drop.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      els.drop.addEventListener(eventName, function (e) {
        e.preventDefault();
        els.drop.classList.remove("is-dragover");
      });
    });
    els.drop.addEventListener("drop", function (e) { acceptFile(e.dataTransfer && e.dataTransfer.files); });
  }

  function queueReplacement() {
    if (!state.selected || !state.file) return;
    setStatus("", "Queueing replacement...");
    var form = new FormData();
    form.append("dataset", state.selected.dataset);
    form.append("slug", state.selected.slug);
    form.append("file", state.file, state.file.name);
    fetch(REPLACE_URL, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (json) {
        if (!response.ok) throw new Error(json.error || ("HTTP " + response.status));
        return json;
      });
    }).then(function () {
      state.file = null;
      els.file.value = "";
      renderFile();
      setStatus("ok", "Replacement queued. The replacement workflow will run shortly.");
    }).catch(function (err) {
      setStatus("error", err.message);
    });
  }

  function init() {
    els.signedOut = $("rsdw-manage-signed-out");
    els.signedIn = $("rsdw-manage-signed-in");
    els.login = $("rsdw-manage-login");
    els.logout = $("rsdw-manage-logout");
    els.avatar = $("rsdw-manage-avatar");
    els.name = $("rsdw-manage-name");
    els.username = $("rsdw-manage-username");
    els.panel = $("rsdw-manage-panel");
    els.list = $("rsdw-manage-list");
    els.editor = $("rsdw-manage-editor");
    els.title = $("rsdw-manage-editor-title");
    els.slug = $("rsdw-manage-editor-slug");
    els.view = $("rsdw-manage-view");
    els.nameField = $("rsdw-manage-name-field");
    els.authors = $("rsdw-manage-authors-field");
    els.description = $("rsdw-manage-description-field");
    els.tags = $("rsdw-manage-tags-field");
    els.youtube = $("rsdw-manage-youtube-field");
    els.nexusmods = $("rsdw-manage-nexusmods-field");
    els.issues = $("rsdw-manage-issues");
    els.save = $("rsdw-manage-save");
    els.visibility = $("rsdw-manage-visibility");
    els.drop = $("rsdw-manage-drop");
    els.pick = $("rsdw-manage-pick");
    els.file = $("rsdw-manage-file");
    els.fileList = $("rsdw-manage-file-list");
    els.replace = $("rsdw-manage-replace");
    els.status = $("rsdw-manage-status");
    els.search = $("rsdw-manage-search");

    bindTabs();
    bindDropzone();
    els.login.addEventListener("click", login);
    els.logout.addEventListener("click", logout);
    els.save.addEventListener("click", saveMetadata);
    els.visibility.addEventListener("click", toggleVisibility);
    els.replace.addEventListener("click", queueReplacement);
    els.search.addEventListener("input", function () {
      state.query = els.search.value;
      renderList();
    });

    supabase.auth.getSession().then(function (result) { renderAuth(result.data && result.data.session); });
    supabase.auth.onAuthStateChange(function (_event, session) { renderAuth(session); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
