import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

(function () {
  "use strict";

  var SUPABASE_URL = "https://xvhcniquixigesgqojdk.supabase.co";
  var SUPABASE_KEY = "sb_publishable_Z-ZdcdkLG6T0Kp9VQTGV3Q_yACgE2tI";
  var FUNCTION_URL = SUPABASE_URL + "/functions/v1/upload-submission";
  var MAX_ZIP_BYTES = 25 * 1024 * 1024;

  var supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  });

  var selectedFile = null;
  var currentSession = null;
  var els = {};

  function $(id) { return document.getElementById(id); }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  function githubMetadata(user) {
    var meta = (user && user.user_metadata) || {};
    return {
      name: meta.full_name || meta.name || meta.user_name || meta.preferred_username || "GitHub user",
      username: meta.user_name || meta.preferred_username || meta.login || "",
      avatar: meta.avatar_url || meta.picture || "",
    };
  }

  function setIssues(messages) {
    if (!messages.length) {
      els.issues.hidden = true;
      els.issues.replaceChildren();
      return;
    }
    els.issues.hidden = false;
    els.issues.replaceChildren();
    var ul = document.createElement("ul");
    messages.forEach(function (msg) {
      var li = document.createElement("li");
      li.textContent = msg;
      ul.appendChild(li);
    });
    els.issues.appendChild(ul);
  }

  function setStatus(kind, content) {
    els.status.hidden = !content;
    els.status.className = "rsdw-upload__status";
    if (kind) els.status.classList.add("is-" + kind);
    els.status.replaceChildren();
    if (!content) return;
    if (typeof content === "string") {
      els.status.textContent = content;
    } else {
      els.status.appendChild(content);
    }
  }

  function validateFile(file) {
    var issues = [];
    if (!file) {
      issues.push("Choose a submission zip.");
      return issues;
    }
    if (!/\.zip$/i.test(file.name)) {
      issues.push("File must end with .zip.");
    }
    if (file.size <= 0) {
      issues.push("File is empty.");
    }
    if (file.size > MAX_ZIP_BYTES) {
      issues.push("File must be " + fmtSize(MAX_ZIP_BYTES) + " or smaller.");
    }
    return issues;
  }

  function renderFile() {
    els.fileList.replaceChildren();
    if (!selectedFile) {
      els.submit.disabled = true;
      setIssues([]);
      return;
    }

    var li = document.createElement("li");
    var name = document.createElement("span");
    name.className = "rsdw-filelist__name";
    name.textContent = selectedFile.name;
    var size = document.createElement("span");
    size.className = "rsdw-filelist__size";
    size.textContent = fmtSize(selectedFile.size);
    var remove = document.createElement("button");
    remove.className = "rsdw-filelist__remove";
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove selected file");
    remove.textContent = "\u00d7";
    remove.addEventListener("click", function () {
      selectedFile = null;
      els.file.value = "";
      renderFile();
    });
    li.appendChild(name);
    li.appendChild(size);
    li.appendChild(remove);
    els.fileList.appendChild(li);

    var issues = validateFile(selectedFile);
    setIssues(issues);
    els.submit.disabled = issues.length > 0 || !currentSession;
  }

  function acceptFiles(files) {
    selectedFile = files && files[0] ? files[0] : null;
    setStatus("", "");
    renderFile();
  }

  function bindDropzone() {
    els.pick.addEventListener("click", function () {
      els.file.click();
    });
    els.drop.addEventListener("click", function (e) {
      if (e.target !== els.pick) els.file.click();
    });
    els.drop.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        els.file.click();
      }
    });
    els.file.addEventListener("change", function () {
      acceptFiles(els.file.files);
    });
    ["dragenter", "dragover"].forEach(function (eventName) {
      els.drop.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.drop.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      els.drop.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.drop.classList.remove("is-dragover");
      });
    });
    els.drop.addEventListener("drop", function (e) {
      acceptFiles(e.dataTransfer && e.dataTransfer.files);
    });
  }

  function renderAuth(session) {
    currentSession = session;
    var signedIn = !!(session && session.user);
    els.signedOut.hidden = signedIn;
    els.signedIn.hidden = !signedIn;
    els.panel.hidden = !signedIn;

    if (signedIn) {
      var meta = githubMetadata(session.user);
      els.name.textContent = meta.name;
      els.username.textContent = meta.username ? "@" + meta.username : "";
      if (meta.avatar) {
        els.avatar.src = meta.avatar;
        els.avatar.hidden = false;
      } else {
        els.avatar.removeAttribute("src");
        els.avatar.hidden = true;
      }
    }
    renderFile();
  }

  function login() {
    supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: window.location.origin + "/upload/",
      },
    });
  }

  function logout() {
    supabase.auth.signOut();
    selectedFile = null;
    setStatus("", "");
  }

  function link(href, label) {
    var a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    return a;
  }

  function renderSuccess(result) {
    var wrap = document.createElement("div");
    wrap.appendChild(document.createTextNode("Uploaded " + result.path + "."));
    if (result.workflow_html_url || result.commit_html_url) {
      wrap.appendChild(document.createElement("br"));
      if (result.workflow_html_url) {
        wrap.appendChild(link(result.workflow_html_url, "View workflow run"));
      }
      if (result.workflow_html_url && result.commit_html_url) {
        wrap.appendChild(document.createTextNode(" | "));
      }
      if (result.commit_html_url) {
        wrap.appendChild(link(result.commit_html_url, "View upload commit"));
      }
    }
    setStatus("ok", wrap);
  }

  function upload() {
    var issues = validateFile(selectedFile);
    setIssues(issues);
    if (issues.length || !currentSession) return;

    els.submit.disabled = true;
    setStatus("", "Uploading...");

    var form = new FormData();
    form.append("file", selectedFile, selectedFile.name);

    fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + currentSession.access_token,
      },
      body: form,
    })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (body) {
            if (!response.ok) {
              throw new Error(body.error || ("Upload failed with HTTP " + response.status));
            }
            return body;
          });
      })
      .then(function (result) {
        selectedFile = null;
        els.file.value = "";
        renderFile();
        renderSuccess(result);
      })
      .catch(function (err) {
        setStatus("error", err.message || "Upload failed.");
        renderFile();
      });
  }

  function init() {
    els.signedOut = $("rsdw-upload-signed-out");
    els.signedIn = $("rsdw-upload-signed-in");
    els.login = $("rsdw-upload-login");
    els.logout = $("rsdw-upload-logout");
    els.avatar = $("rsdw-upload-avatar");
    els.name = $("rsdw-upload-name");
    els.username = $("rsdw-upload-username");
    els.panel = $("rsdw-upload-panel");
    els.drop = $("rsdw-upload-drop");
    els.pick = $("rsdw-upload-pick");
    els.file = $("rsdw-upload-file");
    els.fileList = $("rsdw-upload-file-list");
    els.issues = $("rsdw-upload-issues");
    els.submit = $("rsdw-upload-submit");
    els.status = $("rsdw-upload-status");

    bindDropzone();
    els.login.addEventListener("click", login);
    els.logout.addEventListener("click", logout);
    els.submit.addEventListener("click", upload);

    supabase.auth.getSession().then(function (result) {
      renderAuth(result.data && result.data.session);
    });
    supabase.auth.onAuthStateChange(function (_event, session) {
      renderAuth(session);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
