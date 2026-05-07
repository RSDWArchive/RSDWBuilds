/* RSDWBuilds gallery page.
 *
 * Loads /data/<dataset>/index.json -> { builds: ["<slug>", ...] }, then
 * fetches /data/<dataset>/<slug>/build.json for each entry. Renders cards
 * with pagination + tag chips + token search (shared header input).
 *
 * Card schema (build.json), all paths relative to the build folder:
 *   {
 *     "name":         "Cozy Cottage",
 *     "description":  "...",
 *     "authors":      ["PlayerName", ...],
 *     "tags":         ["small", "starter"],
 *     "image":        "cover.jpg",
 *     "images":       ["cover.jpg", "interior.jpg"],
 *     "download":     "download.json"
 *   }
 *
 * Page configures itself with window.RSDW_GALLERY_CONFIG = {
 *   dataset:    "builds",   // folder under /data/
 *   pageSize:   24,
 *   emptyText:  "No builds yet."
 * };
 */
(function () {
  "use strict";

  var cfg = Object.assign(
    { dataset: "builds", pageSize: 24, emptyText: "No entries yet." },
    window.RSDW_GALLERY_CONFIG || {}
  );

  var state = {
    items: [],          // [{ slug, folder, data }]
    filtered: [],
    page: 1,
    query: "",
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== false && attrs[k] != null) {
          node.setAttribute(k, attrs[k]);
        }
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    });
    return node;
  }

  function joinPath(folder, rel) {
    if (!rel) return "";
    if (/^https?:/i.test(rel) || rel.startsWith("/")) return rel;
    return folder + "/" + rel;
  }

  function authorsString(authors) {
    if (!authors || !authors.length) return "";
    if (authors.length === 1) return "by " + authors[0];
    if (authors.length === 2) return "by " + authors.join(" & ");
    return "by " + authors.slice(0, -1).join(", ") + " & " + authors[authors.length - 1];
  }

  function buildHaystack(item) {
    var d = item.data || {};
    var parts = [d.name || "", d.description || ""]
      .concat(d.authors || [])
      .concat(d.tags || [])
      .concat([item.slug]);
    return parts.join(" \u0001 ").toLowerCase();
  }

  function load() {
    var manifestUrl = "/data/" + cfg.dataset + "/index.json";
    fetch(manifestUrl, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("manifest " + r.status);
        return r.json();
      })
      .then(function (manifest) {
        var slugs = (manifest && (manifest.entries || manifest[cfg.dataset])) || [];
        return Promise.all(
          slugs.map(function (slug) {
            var folder = "/data/" + cfg.dataset + "/" + slug;
            return fetch(folder + "/build.json", { cache: "no-cache" })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (data) {
                if (!data) return null;
                return { slug: slug, folder: folder, data: data };
              })
              .catch(function () { return null; });
          })
        );
      })
      .then(function (items) {
        state.items = items.filter(Boolean);
        state.items.forEach(function (it) { it.haystack = buildHaystack(it); });
        applyFilter();
      })
      .catch(function (err) {
        console.error("[gallery] load failed:", err);
        var grid = $("rsdw-gallery");
        if (grid) {
          grid.replaceChildren(
            el("p", { class: "rsdw-empty" }, ["Failed to load gallery data."])
          );
        }
      });
  }

  function applyFilter() {
    var q = state.query.trim();
    var match = window.rsdwHaystackMatchesQuery;
    if (!q) {
      state.filtered = state.items.slice();
    } else if (match) {
      state.filtered = state.items.filter(function (it) {
        return match(it.haystack, q);
      });
    } else {
      var ql = q.toLowerCase();
      state.filtered = state.items.filter(function (it) {
        return it.haystack.indexOf(ql) >= 0;
      });
    }
    // Sort by name for stable ordering.
    state.filtered.sort(function (a, b) {
      return (a.data.name || a.slug).localeCompare(b.data.name || b.slug);
    });
    state.page = 1;
    render();
  }

  function render() {
    var grid = $("rsdw-gallery");
    var count = $("rsdw-gallery-count");
    var pagi = $("rsdw-pagination");
    if (!grid) return;

    if (count) {
      var total = state.items.length;
      var shown = state.filtered.length;
      count.textContent = shown === total
        ? shown + (total === 1 ? " entry" : " entries")
        : shown + " of " + total + " entries";
    }

    grid.replaceChildren();
    if (state.filtered.length === 0) {
      grid.appendChild(el("p", { class: "rsdw-empty" }, [cfg.emptyText]));
      if (pagi) pagi.replaceChildren();
      return;
    }

    var pages = Math.max(1, Math.ceil(state.filtered.length / cfg.pageSize));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * cfg.pageSize;
    var slice = state.filtered.slice(start, start + cfg.pageSize);

    slice.forEach(function (it) {
      grid.appendChild(makeCard(it));
    });

    if (pagi) renderPagination(pagi, pages);
  }

  function makeCard(it) {
    var d = it.data;
    var imgPath = d.image || (d.images && d.images[0]);
    var imgFull = imgPath ? joinPath(it.folder, imgPath) : "";

    var media;
    if (imgFull) {
      media = el("div", { class: "rsdw-card__media" });
      media.style.backgroundImage = "url(\"" + cssEscape(imgFull) + "\")";
    } else {
      media = el("div", { class: "rsdw-card__media rsdw-card__media--placeholder" }, [
        "No Image",
      ]);
    }

    var body = el("div", { class: "rsdw-card__body" }, [
      el("div", { class: "rsdw-card__name" }, [d.name || it.slug]),
      d.authors && d.authors.length
        ? el("div", { class: "rsdw-card__author" }, [authorsString(d.authors)])
        : null,
      d.description
        ? el("div", { class: "rsdw-card__desc" }, [d.description])
        : null,
    ]);

    var card = el(
      "button",
      { class: "rsdw-card", type: "button", "aria-label": "Open " + (d.name || it.slug) },
      [media, body]
    );
    card.addEventListener("click", function () { openLightbox(it); });
    return card;
  }

  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, "\\$1");
  }

  function renderPagination(host, pages) {
    host.replaceChildren();
    if (pages <= 1) return;
    var page = state.page;

    function btn(label, target, opts) {
      opts = opts || {};
      var b = el("button", { type: "button" }, [label]);
      if (opts.active) b.classList.add("is-active");
      if (opts.disabled) b.disabled = true;
      else b.addEventListener("click", function () {
        state.page = target;
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      return b;
    }

    host.appendChild(btn("Prev", page - 1, { disabled: page === 1 }));

    // Compact page numbers: 1 ... p-1 p p+1 ... N
    var nums = new Set([1, pages, page, page - 1, page + 1]);
    var sorted = Array.from(nums).filter(function (n) {
      return n >= 1 && n <= pages;
    }).sort(function (a, b) { return a - b; });

    var prev = 0;
    sorted.forEach(function (n) {
      if (n - prev > 1) {
        host.appendChild(el("span", { class: "rsdw-pagination__ellipsis" }, ["..."]));
      }
      host.appendChild(btn(String(n), n, { active: n === page }));
      prev = n;
    });

    host.appendChild(btn("Next", page + 1, { disabled: page === pages }));
  }

  /* === Lightbox === */

  var lightbox = {
    el: null, img: null, title: null, author: null, desc: null,
    counter: null, tags: null, prev: null, next: null,
    download: null, youtube: null, nexusmods: null,
    item: null, index: 0,
  };

  function ensureLightbox() {
    if (lightbox.el) return;
    var topbar = el("div", { class: "rsdw-lightbox__topbar" }, [
      lightbox.title = el("h2", { class: "rsdw-lightbox__title" }, [""]),
      lightbox.author = el("span", { class: "rsdw-lightbox__author" }, [""]),
      el("div", { class: "rsdw-lightbox__spacer" }),
      lightbox.youtube = el("a", {
        class: "rsdw-lightbox__btn",
        href: "#", target: "_blank", rel: "noopener",
      }, ["YouTube"]),
      lightbox.nexusmods = el("a", {
        class: "rsdw-lightbox__btn",
        href: "#", target: "_blank", rel: "noopener",
      }, ["NexusMods"]),
      lightbox.download = el("a", {
        class: "rsdw-lightbox__btn rsdw-lightbox__btn--primary",
        href: "#", download: "", target: "_blank", rel: "noopener",
      }, ["Download"]),
      el("button", {
        class: "rsdw-lightbox__close",
        type: "button",
        "aria-label": "Close",
        onclick: closeLightbox,
      }, ["\u00d7"]),
    ]);

    lightbox.img = el("img", { class: "rsdw-lightbox__image", alt: "" });
    lightbox.prev = el("button", {
      class: "rsdw-lightbox__nav rsdw-lightbox__nav--prev",
      type: "button", "aria-label": "Previous image",
      onclick: function (e) { e.stopPropagation(); navigateLightbox(-1); },
    }, ["\u2039"]);
    lightbox.next = el("button", {
      class: "rsdw-lightbox__nav rsdw-lightbox__nav--next",
      type: "button", "aria-label": "Next image",
      onclick: function (e) { e.stopPropagation(); navigateLightbox(1); },
    }, ["\u203a"]);

    var stage = el("div", { class: "rsdw-lightbox__stage" }, [
      lightbox.prev, lightbox.img, lightbox.next,
    ]);

    var bottom = el("div", { class: "rsdw-lightbox__bottom" }, [
      lightbox.counter = el("div", { class: "rsdw-lightbox__counter" }, [""]),
      lightbox.desc = el("p", { class: "rsdw-lightbox__desc" }, [""]),
      lightbox.tags = el("div", { class: "rsdw-lightbox__tags" }),
    ]);

    lightbox.el = el("div", {
      class: "rsdw-lightbox", role: "dialog", "aria-modal": "true", hidden: "",
    }, [topbar, stage, bottom]);
    document.body.appendChild(lightbox.el);

    // Click backdrop to close (but not when clicking interior).
    lightbox.el.addEventListener("click", function (e) {
      if (e.target === lightbox.el) closeLightbox();
    });

    // Keyboard navigation.
    document.addEventListener("keydown", function (e) {
      if (lightbox.el.hidden) return;
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") navigateLightbox(-1);
      else if (e.key === "ArrowRight") navigateLightbox(1);
    });

    // Touch swipe on the stage.
    var touchStartX = null;
    stage.addEventListener("touchstart", function (e) {
      if (e.touches.length === 1) touchStartX = e.touches[0].clientX;
    }, { passive: true });
    stage.addEventListener("touchend", function (e) {
      if (touchStartX == null) return;
      var dx = (e.changedTouches[0].clientX - touchStartX);
      touchStartX = null;
      if (Math.abs(dx) > 40) navigateLightbox(dx < 0 ? 1 : -1);
    });
  }

  function openLightbox(item) {
    ensureLightbox();
    lightbox.item = item;
    lightbox.index = 0;
    var d = item.data;
    lightbox.title.textContent = d.name || item.slug;
    lightbox.author.textContent = authorsString(d.authors || []);
    lightbox.desc.textContent = d.description || "";
    lightbox.tags.replaceChildren();
    (d.tags || []).forEach(function (t) {
      lightbox.tags.appendChild(el("span", { class: "rsdw-lightbox__tag" }, [t]));
    });
    if (d.download) {
      var dl = joinPath(item.folder, d.download);
      lightbox.download.href = dl;
      lightbox.download.style.display = "";
      // Hint a sensible download filename.
      var name = (d.name || item.slug).replace(/[^a-z0-9]+/gi, "_");
      lightbox.download.setAttribute("download", name + ".json");
    } else {
      lightbox.download.style.display = "none";
    }
    if (d.youtube) {
      lightbox.youtube.href = d.youtube;
      lightbox.youtube.style.display = "";
    } else {
      lightbox.youtube.style.display = "none";
    }
    if (d.nexusmods) {
      lightbox.nexusmods.href = d.nexusmods;
      lightbox.nexusmods.style.display = "";
    } else {
      lightbox.nexusmods.style.display = "none";
    }
    showLightboxImage();
    lightbox.el.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function showLightboxImage() {
    var d = lightbox.item.data;
    var imgs = (d.images && d.images.length) ? d.images : (d.image ? [d.image] : []);
    if (imgs.length === 0) {
      lightbox.img.removeAttribute("src");
      lightbox.img.alt = "No image";
    } else {
      var src = joinPath(lightbox.item.folder, imgs[lightbox.index]);
      lightbox.img.src = src;
      lightbox.img.alt = d.name || lightbox.item.slug;
    }
    var multi = imgs.length > 1;
    lightbox.prev.hidden = !multi;
    lightbox.next.hidden = !multi;
    lightbox.counter.textContent = multi
      ? (lightbox.index + 1) + " / " + imgs.length
      : "";
  }

  function navigateLightbox(delta) {
    var d = lightbox.item.data;
    var imgs = (d.images && d.images.length) ? d.images : (d.image ? [d.image] : []);
    if (imgs.length < 2) return;
    lightbox.index = (lightbox.index + delta + imgs.length) % imgs.length;
    showLightboxImage();
  }

  function closeLightbox() {
    if (!lightbox.el) return;
    lightbox.el.hidden = true;
    document.body.style.overflow = "";
  }

  /* === Wire up search input from shared header === */

  function wireSearch() {
    var input = document.getElementById("rsdw-search");
    if (!input) return;
    var t = null;
    input.addEventListener("input", function () {
      state.query = input.value;
      clearTimeout(t);
      t = setTimeout(applyFilter, 100);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        input.value = "";
        state.query = "";
        applyFilter();
      }
    });
  }

  function init() {
    wireSearch();
    load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
