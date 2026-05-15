/* RSDWBuilds Tier Converter
 *
 * Pure client-side: load a build .json, show a tier breakdown, let the user
 * pick T1/T2/T3 swap targets per source tier, then download a rewritten file.
 *
 * Pieces are matched against /data/tier_pairs.json by their full
 * piece_data_name (the stable Unreal asset path). When a target tier has no
 * equivalent for a given stem, the piece is left untouched.
 */
(function () {
  "use strict";

  var TIER_LABEL = { 1: "Tier 1", 2: "Tier 2", 3: "Tier 3" };
  var PAIRS_URL = "/data/tier_pairs.json";

  var state = {
    pairs: null,        // tier_pairs.json
    filename: null,
    raw: null,          // parsed JSON object
    pieces: null,       // reference to pieces array inside raw
    breakdown: null,    // { '1': N, '2': N, '3': N, untiered: N }
    categories: null,   // { Walls: N, Floor: N, ... } counts of TIERED pieces only
    enabledCats: null,  // Set of category names currently enabled
    targets: { 1: 0, 2: 0, 3: 0 }, // 0 = no change
  };

  var els = {};

  document.addEventListener("DOMContentLoaded", function () {
    els.drop = document.getElementById("rsdw-conv-drop");
    els.file = document.getElementById("rsdw-conv-file");
    els.panel = document.getElementById("rsdw-conv-panel");
    els.filename = document.getElementById("rsdw-conv-filename");
    els.summary = document.getElementById("rsdw-conv-summary");
    els.breakdown = document.getElementById("rsdw-conv-breakdown");
    els.rows = document.getElementById("rsdw-conv-rows");
    els.cats = document.getElementById("rsdw-conv-cats");
    els.run = document.getElementById("rsdw-conv-run");
    els.clear = document.getElementById("rsdw-conv-clear");
    els.report = document.getElementById("rsdw-conv-report");

    bindDropzone();
    els.clear.addEventListener("click", reset);
    els.run.addEventListener("click", runConversion);

    fetch(PAIRS_URL, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        state.pairs = j;
      })
      .catch(function (err) {
        showFatal("Failed to load tier pairs table: " + err.message);
      });
  });

  function bindDropzone() {
    els.drop.addEventListener("click", function () {
      els.file.click();
    });
    els.drop.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        els.file.click();
      }
    });
    els.file.addEventListener("change", function () {
      var f = els.file.files && els.file.files[0];
      if (f) loadFile(f);
      els.file.value = "";
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      els.drop.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.drop.classList.add("is-drag");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      els.drop.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.drop.classList.remove("is-drag");
      });
    });
    els.drop.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
  }

  function loadFile(file) {
    if (!state.pairs) {
      showFatal("Tier pairs table not loaded yet, please retry.");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        accept(file.name, parsed);
      } catch (err) {
        showFatal("That file is not valid JSON: " + err.message);
      }
    };
    reader.onerror = function () {
      showFatal("Could not read the file.");
    };
    reader.readAsText(file);
  }

  function findPiecesArray(obj) {
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.pieces)) return obj.pieces;
    // Some exports wrap pieces deeper - look one level down for an array of
    // objects that look like pieces.
    if (obj && typeof obj === "object") {
      for (var k in obj) {
        if (Array.isArray(obj[k]) && obj[k].length && obj[k][0] &&
            typeof obj[k][0] === "object" &&
            "piece_data_name" in obj[k][0]) {
          return obj[k];
        }
      }
    }
    return null;
  }

  function accept(name, parsed) {
    var pieces = findPiecesArray(parsed);
    if (!pieces) {
      showFatal("Could not find a 'pieces' array in this file.");
      return;
    }
    state.filename = name;
    state.raw = parsed;
    state.pieces = pieces;
    state.targets = { 1: 0, 2: 0, 3: 0 };
    state.breakdown = computeBreakdown(pieces);
    state.categories = computeCategoryCounts(pieces);
    state.enabledCats = new Set(Object.keys(state.categories));

    els.filename.textContent = name;
    els.summary.textContent =
      pieces.length + " pieces \u00b7 " +
      (state.breakdown[1] + state.breakdown[2] + state.breakdown[3]) +
      " tiered \u00b7 " + state.breakdown.untiered + " untiered";
    renderBreakdown();
    renderRows();
    renderCategories();
    els.report.hidden = true;
    els.panel.hidden = false;
    updateRunEnabled();
    els.panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function computeBreakdown(pieces) {
    var b = { 1: 0, 2: 0, 3: 0, untiered: 0 };
    var byName = state.pairs.by_data_name;
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      var nm = p && p.piece_data_name;
      var hit = nm && byName[nm];
      if (hit) b[hit.tier] += 1;
      else b.untiered += 1;
    }
    return b;
  }

  function computeCategoryCounts(pieces) {
    var counts = {};
    var byName = state.pairs.by_data_name;
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      var nm = p && p.piece_data_name;
      var hit = nm && byName[nm];
      if (!hit) continue;
      var cat = hit.stem.split("/")[0];
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }

  function renderBreakdown() {
    var b = state.breakdown;
    els.breakdown.innerHTML = "";
    [1, 2, 3].forEach(function (t) {
      var pill = document.createElement("span");
      pill.className = "rsdw-conv__pill rsdw-conv__pill--t" + t;
      pill.textContent = TIER_LABEL[t] + ": " + b[t];
      els.breakdown.appendChild(pill);
    });
    var u = document.createElement("span");
    u.className = "rsdw-conv__pill rsdw-conv__pill--untiered";
    u.textContent = "Untiered: " + b.untiered;
    els.breakdown.appendChild(u);
  }

  function renderRows() {
    els.rows.innerHTML = "";
    [1, 2, 3].forEach(function (src) {
      var row = document.createElement("div");
      row.className = "rsdw-conv__row";

      var label = document.createElement("label");
      label.className = "rsdw-conv__row-label";
      label.htmlFor = "rsdw-conv-target-" + src;
      label.textContent = TIER_LABEL[src] + " \u2192";
      row.appendChild(label);

      var sel = document.createElement("select");
      sel.id = "rsdw-conv-target-" + src;
      sel.className = "rsdw-conv__select";
      sel.disabled = state.breakdown[src] === 0;

      var optNone = document.createElement("option");
      optNone.value = "0";
      optNone.textContent = "(no change)";
      sel.appendChild(optNone);

      [1, 2, 3].forEach(function (dst) {
        if (dst === src) return;
        var o = document.createElement("option");
        o.value = String(dst);
        o.textContent = TIER_LABEL[dst];
        sel.appendChild(o);
      });
      sel.value = String(state.targets[src] || 0);
      sel.addEventListener("change", function () {
        state.targets[src] = parseInt(sel.value, 10) || 0;
        updateRunEnabled();
      });
      row.appendChild(sel);

      var count = document.createElement("span");
      count.className = "rsdw-conv__row-count";
      count.textContent = state.breakdown[src] + " in build";
      row.appendChild(count);

      els.rows.appendChild(row);
    });
  }

  function renderCategories() {
    els.cats.innerHTML = "";
    var names = Object.keys(state.categories).sort();
    if (!names.length) {
      var none = document.createElement("p");
      none.className = "rsdw-conv__hint";
      none.textContent = "No tiered pieces in this build.";
      els.cats.appendChild(none);
      return;
    }

    var bar = document.createElement("div");
    bar.className = "rsdw-conv__cats-bar";
    var allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "rsdw-link-btn";
    allBtn.textContent = "All";
    allBtn.addEventListener("click", function () {
      state.enabledCats = new Set(names);
      renderCategories();
      updateRunEnabled();
    });
    var noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.className = "rsdw-link-btn";
    noneBtn.textContent = "None";
    noneBtn.addEventListener("click", function () {
      state.enabledCats = new Set();
      renderCategories();
      updateRunEnabled();
    });
    bar.appendChild(allBtn);
    bar.appendChild(document.createTextNode(" \u00b7 "));
    bar.appendChild(noneBtn);
    els.cats.appendChild(bar);

    var grid = document.createElement("div");
    grid.className = "rsdw-conv__cats-grid";
    names.forEach(function (cat) {
      var id = "rsdw-conv-cat-" + cat;
      var lbl = document.createElement("label");
      lbl.className = "rsdw-conv__cat";
      lbl.htmlFor = id;
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id;
      cb.checked = state.enabledCats.has(cat);
      cb.addEventListener("change", function () {
        if (cb.checked) state.enabledCats.add(cat);
        else state.enabledCats.delete(cat);
        updateRunEnabled();
      });
      var name = document.createElement("span");
      name.className = "rsdw-conv__cat-name";
      name.textContent = cat;
      var count = document.createElement("span");
      count.className = "rsdw-conv__cat-count";
      count.textContent = state.categories[cat];
      lbl.appendChild(cb);
      lbl.appendChild(name);
      lbl.appendChild(count);
      grid.appendChild(lbl);
    });
    els.cats.appendChild(grid);
  }

  function updateRunEnabled() {
    var anyChange =
      (state.targets[1] && state.breakdown[1]) ||
      (state.targets[2] && state.breakdown[2]) ||
      (state.targets[3] && state.breakdown[3]);
    var anyCat = state.enabledCats && state.enabledCats.size > 0;
    els.run.disabled = !(anyChange && anyCat);
  }

  function runConversion() {
    var pairs = state.pairs;
    var byName = pairs.by_data_name;
    var stems = pairs.stems;

    var converted = 0;
    var alreadyAtTarget = 0;
    var noEquivalent = 0;
    var unchanged = 0;
    var skippedByCategory = 0;
    var noEquivExamples = {};

    // Deep-clone so we don't mutate the source if the user wants to retry.
    var out = JSON.parse(JSON.stringify(state.raw));
    var pieces = findPiecesArray(out);

    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      var nm = p && p.piece_data_name;
      var hit = nm && byName[nm];
      if (!hit) {
        unchanged += 1;
        continue;
      }
      var cat = hit.stem.split("/")[0];
      if (!state.enabledCats.has(cat)) {
        skippedByCategory += 1;
        continue;
      }
      var src = hit.tier;
      var dst = state.targets[src];
      if (!dst) {
        unchanged += 1;
        continue;
      }
      if (dst === src) {
        alreadyAtTarget += 1;
        continue;
      }
      var stemEntry = stems[hit.stem];
      var target = stemEntry && stemEntry[String(dst)];
      if (!target) {
        noEquivalent += 1;
        noEquivExamples[hit.stem] = (noEquivExamples[hit.stem] || 0) + 1;
        continue;
      }
      p.piece_data_index = target.piece_data_index;
      p.piece_data_name = target.piece_data_name;
      p.class_name = target.class_name;
      converted += 1;
    }

    renderReport({
      converted: converted,
      alreadyAtTarget: alreadyAtTarget,
      noEquivalent: noEquivalent,
      unchanged: unchanged,
      skippedByCategory: skippedByCategory,
      noEquivExamples: noEquivExamples,
    });

    triggerDownload(out);
  }

  function renderReport(r) {
    els.report.hidden = false;
    els.report.innerHTML = "";

    var head = document.createElement("h2");
    head.textContent = "Conversion report";
    els.report.appendChild(head);

    var ul = document.createElement("ul");
    ul.className = "rsdw-conv__report-list";
    [
      ["Converted", r.converted, "ok"],
      ["Already at target tier", r.alreadyAtTarget, ""],
      ["Skipped by category filter", r.skippedByCategory, ""],
      ["Untiered or kept (source tier had no swap)", r.unchanged, ""],
      ["No equivalent in target tier (kept original)", r.noEquivalent,
        r.noEquivalent ? "warn" : ""],
    ].forEach(function (row) {
      var li = document.createElement("li");
      if (row[2]) li.className = "is-" + row[2];
      var k = document.createElement("span");
      k.className = "rsdw-conv__report-k";
      k.textContent = row[0];
      var v = document.createElement("span");
      v.className = "rsdw-conv__report-v";
      v.textContent = row[1];
      li.appendChild(k);
      li.appendChild(v);
      ul.appendChild(li);
    });
    els.report.appendChild(ul);

    var examples = Object.keys(r.noEquivExamples);
    if (examples.length) {
      var det = document.createElement("details");
      det.className = "rsdw-conv__report-details";
      var sum = document.createElement("summary");
      sum.textContent =
        "Stems with no equivalent (" + examples.length + ")";
      det.appendChild(sum);
      examples.sort();
      var dl = document.createElement("dl");
      examples.forEach(function (stem) {
        var dt = document.createElement("dt");
        dt.textContent = stem;
        var dd = document.createElement("dd");
        dd.textContent = r.noEquivExamples[stem] + " piece(s)";
        dl.appendChild(dt);
        dl.appendChild(dd);
      });
      det.appendChild(dl);
      els.report.appendChild(det);
    }
  }

  function triggerDownload(obj) {
    var json = JSON.stringify(obj);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = suggestFilename(state.filename, state.targets);
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  function suggestFilename(name, targets) {
    var base = (name || "build.json").replace(/\.json$/i, "");
    var parts = [];
    [1, 2, 3].forEach(function (s) {
      if (targets[s] && targets[s] !== s) {
        parts.push("T" + s + "to" + targets[s]);
      }
    });
    var suffix = parts.length ? "_" + parts.join("_") : "_converted";
    return base + suffix + ".json";
  }

  function reset() {
    state.filename = null;
    state.raw = null;
    state.pieces = null;
    state.breakdown = null;
    state.categories = null;
    state.enabledCats = null;
    state.targets = { 1: 0, 2: 0, 3: 0 };
    els.panel.hidden = true;
    els.report.hidden = true;
    els.report.innerHTML = "";
  }

  function showFatal(msg) {
    els.report.hidden = false;
    els.report.innerHTML = "";
    var p = document.createElement("p");
    p.className = "rsdw-conv__error";
    p.textContent = msg;
    els.report.appendChild(p);
    els.panel.hidden = false;
  }
})();
