/* RSDWBuilds submission packager.
 *
 * Collects form values + dropped files, validates them with the same rules
 * as tools/validate_and_promote.py, then builds a .zip in the browser via
 * JSZip. The zip's top-level folder is `<dataset>/<slug>/` so the
 * maintainer can extract it directly into website/staging/ and run the
 * validator unchanged.
 */
(function () {
  "use strict";

  var SLUG_RE = /^[a-z0-9][a-z0-9_\-]*$/;
  var IMG_TYPES = {
    "image/jpeg": ".jpg",
    "image/png":  ".png",
    "image/webp": ".webp",
    "image/gif":  ".gif",
  };
  var MAX_IMG_BYTES = 10 * 1024 * 1024;
  var MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

  // Words stripped before harvesting tags from the build name. Common English
  // articles/prepositions plus generic noise that adds no filter value.
  var STOPWORDS = new Set([
    "a", "an", "and", "the", "of", "on", "in", "at", "to", "for", "by",
    "with", "from", "into", "onto", "my", "our", "your", "their", "this",
    "that", "these", "those", "is", "it", "as", "or", "but", "new", "old",
  ]);

  // Singular tags for the category dropdown.
  var DATASET_TAG = { builds: "build", prefabs: "prefab" };

  var images = [];     // [{ file, name, ext }]
  var download = null; // { file, name }
  var existingSlugs = {};   // dataset -> Set of taken slugs (lowercase)
  var manifestsLoaded = {}; // dataset -> Promise

  function $(id) { return document.getElementById(id); }

  function slugify(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function safeBaseName(name) {
    // Keep extension; strip path; replace unsafe chars in the stem.
    var base = name.replace(/^.*[\\\/]/, "");
    var dot = base.lastIndexOf(".");
    var stem = dot > 0 ? base.slice(0, dot) : base;
    var ext = dot > 0 ? base.slice(dot) : "";
    stem = stem.replace(/[^a-z0-9_\-]+/gi, "_").slice(0, 60) || "file";
    return stem + ext.toLowerCase();
  }

  /* === File pickers / drop zones === */

  function wireDrop(zoneId, inputId, pickBtnId, onFiles) {
    var zone = $(zoneId);
    var input = $(inputId);
    var pick = $(pickBtnId);
    if (!zone || !input || !pick) return;

    pick.addEventListener("click", function () { input.click(); });
    zone.addEventListener("click", function (e) {
      if (e.target === zone || e.target.classList.contains("rsdw-drop__label")) {
        input.click();
      }
    });
    zone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    input.addEventListener("change", function () {
      if (input.files && input.files.length) onFiles(Array.from(input.files));
      input.value = "";
    });

    ["dragenter", "dragover"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (ev === "dragleave" && e.target !== zone) return;
        zone.classList.remove("is-dragover");
      });
    });
    zone.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) onFiles(Array.from(files));
    });
  }

  function addImages(files) {
    files.forEach(function (f) {
      var ext = IMG_TYPES[f.type];
      if (!ext) return;
      if (f.size > MAX_IMG_BYTES) return;
      // Avoid exact duplicates.
      var key = f.name + ":" + f.size;
      if (images.some(function (i) { return i.key === key; })) return;
      images.push({
        file: f,
        key: key,
        name: safeBaseName(f.name),
        ext: ext,
      });
    });
    renderImages();
    revalidate();
  }

  function setDownload(files) {
    var f = files[0];
    if (!f) return;
    if (f.size > MAX_DOWNLOAD_BYTES) {
      download = null;
    } else {
      download = { file: f, name: safeBaseName(f.name) };
    }
    renderDownload();
    revalidate();
  }

  function renderImages() {
    var list = $("f-images-list");
    list.replaceChildren();
    images.forEach(function (img, idx) {
      var li = document.createElement("li");

      var thumb = document.createElement("img");
      thumb.className = "rsdw-filelist__thumb";
      thumb.alt = "";
      thumb.src = URL.createObjectURL(img.file);
      thumb.addEventListener("load", function () {
        URL.revokeObjectURL(thumb.src);
      });
      li.appendChild(thumb);

      var name = document.createElement("span");
      name.className = "rsdw-filelist__name";
      name.textContent = img.name;
      li.appendChild(name);

      if (idx === 0) {
        var cover = document.createElement("span");
        cover.className = "rsdw-filelist__cover";
        cover.textContent = "Cover";
        li.appendChild(cover);
      }

      var size = document.createElement("span");
      size.className = "rsdw-filelist__size";
      size.textContent = fmtSize(img.file.size);
      li.appendChild(size);

      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rsdw-filelist__remove";
      rm.setAttribute("aria-label", "Remove " + img.name);
      rm.textContent = "\u00d7";
      rm.addEventListener("click", function () {
        images.splice(idx, 1);
        renderImages();
        revalidate();
      });
      li.appendChild(rm);

      list.appendChild(li);
    });
  }

  function renderDownload() {
    var list = $("f-download-list");
    list.replaceChildren();
    if (!download) return;
    var li = document.createElement("li");

    var name = document.createElement("span");
    name.className = "rsdw-filelist__name";
    name.textContent = download.name;
    li.appendChild(name);

    var size = document.createElement("span");
    size.className = "rsdw-filelist__size";
    size.textContent = fmtSize(download.file.size);
    li.appendChild(size);

    var rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rsdw-filelist__remove";
    rm.setAttribute("aria-label", "Remove download file");
    rm.textContent = "\u00d7";
    rm.addEventListener("click", function () {
      download = null;
      renderDownload();
      revalidate();
    });
    li.appendChild(rm);

    list.appendChild(li);
  }

  /* === Auto-derivation === */

  function deriveTags(dataset, name, authors) {
    var tags = [];
    var seen = new Set();
    function add(t) {
      if (!t) return;
      var k = String(t).toLowerCase().trim();
      if (!k || seen.has(k)) return;
      seen.add(k);
      tags.push(k);
    }

    add(DATASET_TAG[dataset] || dataset);

    String(name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter(Boolean)
      .forEach(function (w) {
        if (w.length < 3) return;
        if (STOPWORDS.has(w)) return;
        add(w);
      });

    (authors || []).forEach(function (a) {
      var clean = String(a).toLowerCase().replace(/[^a-z0-9_\-]+/g, "");
      if (clean) add("by-" + clean);
    });

    return tags;
  }

  function uniqueSlug(dataset, base) {
    var taken = existingSlugs[dataset] || new Set();
    if (!taken.has(base)) return { slug: base, suffix: 0 };
    var n = 2;
    while (taken.has(base + "-" + n)) n++;
    return { slug: base + "-" + n, suffix: n };
  }

  function loadExistingSlugs(dataset) {
    if (manifestsLoaded[dataset]) return manifestsLoaded[dataset];
    var url = "/data/" + dataset + "/index.json";
    var p = fetch(url, { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : { entries: [] }; })
      .then(function (m) {
        var list = (m && (m.entries || m[dataset])) || [];
        existingSlugs[dataset] = new Set(list.map(function (s) { return String(s).toLowerCase(); }));
      })
      .catch(function () {
        existingSlugs[dataset] = new Set();
      });
    manifestsLoaded[dataset] = p;
    return p;
  }

  /* === Validation === */

  function readForm() {
    var dataset = $("f-dataset").value;
    var name = $("f-name").value.trim();
    var authors = $("f-authors").value.split(",")
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    var description = $("f-description").value.trim();
    var base = slugify(name);
    var resolved = base ? uniqueSlug(dataset, base) : { slug: "", suffix: 0 };
    return {
      dataset: dataset,
      name: name,
      authors: authors,
      description: description,
      slug: resolved.slug,
      slugBase: base,
      slugSuffix: resolved.suffix,
      tags: deriveTags(dataset, name, authors),
    };
  }

  function validate() {
    var v = readForm();
    var issues = [];

    if (!v.name) issues.push("Name is required.");
    if (!v.slugBase) issues.push("Name must contain at least one letter or digit so a URL slug can be generated.");
    else if (!SLUG_RE.test(v.slug)) issues.push("Generated slug is invalid; try a different name.");
    if (!v.authors.length) issues.push("At least one author is required.");
    if (!v.description) issues.push("Description is required.");
    if (v.description.length > 600) issues.push("Description must be 600 characters or fewer.");
    if (!images.length) issues.push("At least one image is required.");
    if (!download) issues.push("A download file is required.");

    // Detect duplicate image filenames after sanitisation.
    var seen = {};
    images.forEach(function (img) {
      seen[img.name] = (seen[img.name] || 0) + 1;
    });
    Object.keys(seen).forEach(function (n) {
      if (seen[n] > 1) issues.push("Duplicate image filename after sanitization: " + n);
    });

    return { values: v, issues: issues };
  }

  function renderIssues(issues) {
    var box = $("f-issues");
    if (!issues.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    box.replaceChildren();
    var head = document.createElement("strong");
    head.textContent = "Fix these before downloading:";
    box.appendChild(head);
    var ul = document.createElement("ul");
    issues.forEach(function (msg) {
      var li = document.createElement("li");
      li.textContent = msg;
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  function revalidate() {
    var r = validate();
    renderIssues(r.issues);
    renderAuto(r.values);
    $("f-submit-btn").disabled = r.issues.length > 0;
    return r;
  }

  function renderAuto(v) {
    var slugDd = $("f-auto-slug");
    var tagsDd = $("f-auto-tags");
    if (slugDd) {
      slugDd.replaceChildren();
      if (!v.slug) {
        var ph = document.createElement("span");
        ph.className = "rsdw-auto__placeholder";
        ph.textContent = "(enter a name)";
        slugDd.appendChild(ph);
      } else {
        var code = document.createElement("span");
        code.className = "rsdw-auto__slug";
        code.textContent = v.slug;
        slugDd.appendChild(code);
        if (v.slugSuffix) {
          var note = document.createElement("span");
          note.className = "rsdw-auto__slug-note";
          note.textContent = "\u2014 '" + v.slugBase + "' is taken; using '" + v.slug + "'";
          slugDd.appendChild(note);
        }
      }
    }
    if (tagsDd) {
      tagsDd.replaceChildren();
      if (!v.tags.length) {
        var ph2 = document.createElement("span");
        ph2.className = "rsdw-auto__placeholder";
        ph2.textContent = "(none yet)";
        tagsDd.appendChild(ph2);
      } else {
        v.tags.forEach(function (t) {
          var chip = document.createElement("span");
          chip.className = "rsdw-auto__tag";
          chip.textContent = t;
          tagsDd.appendChild(chip);
        });
      }
    }
  }

  /* === Build the card JSON === */

  function buildCardJson(values) {
    return {
      name: values.name,
      description: values.description,
      authors: values.authors,
      tags: values.tags,
      image: images[0].name,
      images: images.map(function (i) { return i.name; }),
      download: download.name,
    };
  }

  /* === Preview === */

  function renderPreview(values) {
    var section = $("f-preview");
    var grid = $("f-preview-grid");
    section.hidden = false;
    grid.replaceChildren();

    var card = document.createElement("div");
    card.className = "rsdw-card";
    card.style.cursor = "default";

    var media;
    if (images.length) {
      media = document.createElement("div");
      media.className = "rsdw-card__media";
      var url = URL.createObjectURL(images[0].file);
      media.style.backgroundImage = 'url("' + url + '")';
    } else {
      media = document.createElement("div");
      media.className = "rsdw-card__media rsdw-card__media--placeholder";
      media.textContent = "No Image";
    }
    card.appendChild(media);

    var body = document.createElement("div");
    body.className = "rsdw-card__body";

    var name = document.createElement("div");
    name.className = "rsdw-card__name";
    name.textContent = values.name || "(untitled)";
    body.appendChild(name);

    if (values.authors.length) {
      var auth = document.createElement("div");
      auth.className = "rsdw-card__author";
      auth.textContent = "by " + values.authors.join(", ");
      body.appendChild(auth);
    }

    if (values.description) {
      var desc = document.createElement("div");
      desc.className = "rsdw-card__desc";
      desc.textContent = values.description;
      body.appendChild(desc);
    }

    card.appendChild(body);
    grid.appendChild(card);
  }

  /* === Build & download zip === */

  function buildZip(values) {
    if (typeof JSZip === "undefined") {
      alert("Zip library failed to load. Check your network and reload.");
      return;
    }
    var zip = new JSZip();
    var folder = zip.folder(values.dataset).folder(values.slug);

    var card = buildCardJson(values);
    folder.file("build.json", JSON.stringify(card, null, 2) + "\n");
    folder.file(download.name, download.file);
    images.forEach(function (img) {
      folder.file(img.name, img.file);
    });

    zip.generateAsync({ type: "blob" }).then(function (blob) {
      var a = document.createElement("a");
      var url = URL.createObjectURL(blob);
      a.href = url;
      a.download = values.dataset + "_" + values.slug + ".zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }).catch(function (err) {
      alert("Failed to build zip: " + err);
    });
  }

  /* === Init === */

  function init() {
    wireDrop("f-images-drop", "f-images-input", "f-images-pick", addImages);
    wireDrop("f-download-drop", "f-download-input", "f-download-pick", setDownload);

    // Pre-load the existing slug manifests for both datasets so we can
    // resolve collisions on the fly.
    Object.keys(DATASET_TAG).forEach(function (ds) {
      loadExistingSlugs(ds).then(revalidate);
    });

    ["f-dataset", "f-name", "f-authors", "f-description"].forEach(function (id) {
      $(id).addEventListener("input", revalidate);
    });
    $("f-dataset").addEventListener("change", revalidate);

    var descEl = $("f-description");
    var descCount = $("f-description-count");
    descEl.addEventListener("input", function () {
      descCount.textContent = String(descEl.value.length);
    });

    $("f-preview-btn").addEventListener("click", function () {
      var r = validate();
      renderPreview(r.values);
    });

    $("rsdw-staging-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var r = revalidate();
      if (r.issues.length === 0) buildZip(r.values);
    });

    revalidate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
