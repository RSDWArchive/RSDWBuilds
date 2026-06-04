/* RSDWBuilds detail page renderer.
 *
 * Detail pages are generated at /builds/<slug>/ and /prefabs/<slug>/, then
 * this script loads /data/<dataset>/<slug>/build.json and renders the entry.
 */
(function () {
  "use strict";

  var cfg = window.RSDW_DETAIL_CONFIG || {};
  var dataset = cfg.dataset || "";
  var slug = cfg.slug || "";
  var folder = "/data/" + dataset + "/" + slug;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== false && attrs[k] != null) {
          node.setAttribute(k, attrs[k]);
        }
      });
    }
    (children || []).forEach(function (child) {
      if (child == null) return;
      if (typeof child === "string") node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    });
    return node;
  }

  function joinPath(rel) {
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

  function imageList(data) {
    var list = [];
    if (Array.isArray(data.images)) {
      data.images.forEach(function (img) {
        if (typeof img === "string" && img && list.indexOf(img) < 0) list.push(img);
      });
    }
    if (!list.length && data.image) list.push(data.image);
    return list;
  }

  function buttonLink(label, href, primary, downloadName) {
    if (!href) return null;
    var attrs = {
      class: primary ? "rsdw-detail__btn rsdw-detail__btn--primary" : "rsdw-detail__btn",
      href: href,
    };
    if (/^https?:/i.test(href)) {
      attrs.target = "_blank";
      attrs.rel = "noopener noreferrer";
    }
    if (downloadName) attrs.download = downloadName;
    return el("a", attrs, [label]);
  }

  function render(data) {
    var host = document.getElementById("rsdw-detail");
    if (!host) return;

    var imgs = imageList(data);
    var title = data.name || slug;
    var author = authorsString(data.authors || []);
    var downloadName = title.replace(/[^a-z0-9]+/gi, "_") + ".json";

    var children = [
      el("div", { class: "rsdw-detail__crumb" }, [
        el("a", { href: "/" + dataset + "/" }, [dataset === "builds" ? "Builds" : "Prefabs"]),
        " / ",
        title,
      ]),
      el("section", { class: "rsdw-detail__hero" }, [
        el("div", { class: "rsdw-detail__copy" }, [
          el("h1", null, [title]),
          author ? el("p", { class: "rsdw-detail__author" }, [author]) : null,
          data.description ? el("p", { class: "rsdw-detail__desc" }, [data.description]) : null,
          el("div", { class: "rsdw-detail__actions" }, [
            data.download ? buttonLink("Download", joinPath(data.download), true, downloadName) : null,
            data.youtube ? buttonLink("YouTube", data.youtube, false) : null,
            data.nexusmods ? buttonLink("NexusMods", data.nexusmods, false) : null,
          ]),
          data.tags && data.tags.length
            ? el("div", { class: "rsdw-detail__tags" }, data.tags.map(function (tag) {
                return el("span", { class: "rsdw-detail__tag" }, [tag]);
              }))
            : null,
        ]),
        imgs.length
          ? el("button", {
              class: "rsdw-detail__cover",
              type: "button",
              "aria-label": "Open image gallery",
              onclick: function () { openLightbox(data, imgs, 0); },
            }, [el("img", { src: joinPath(imgs[0]), alt: title })])
          : el("div", { class: "rsdw-detail__cover rsdw-detail__cover--empty" }, ["No image"]),
      ]),
      imgs.length > 1
        ? el("section", { class: "rsdw-detail__gallery", "aria-label": "Screenshots" },
            imgs.map(function (img, idx) {
              return el("button", {
                class: "rsdw-detail__shot",
                type: "button",
                "aria-label": "Open screenshot " + (idx + 1),
                onclick: function () { openLightbox(data, imgs, idx); },
              }, [el("img", { src: joinPath(img), alt: title + " screenshot " + (idx + 1) })]);
            }))
        : null
    ];
    host.replaceChildren.apply(host, children.filter(Boolean));
  }

  var lightbox = {
    el: null, img: null, counter: null, title: null, prev: null, next: null,
    imgs: [], data: null, index: 0,
  };

  function ensureLightbox() {
    if (lightbox.el) return;
    lightbox.title = el("h2", { class: "rsdw-detail-lightbox__title" }, [""]);
    lightbox.counter = el("span", { class: "rsdw-detail-lightbox__counter" }, [""]);
    lightbox.img = el("img", { class: "rsdw-detail-lightbox__image", alt: "" });
    lightbox.el = el("div", { class: "rsdw-detail-lightbox", role: "dialog", "aria-modal": "true", hidden: "" }, [
      el("div", { class: "rsdw-detail-lightbox__top" }, [
        lightbox.title,
        lightbox.counter,
        el("button", {
          class: "rsdw-lightbox__close",
          type: "button",
          "aria-label": "Close",
          onclick: closeLightbox,
        }, ["\u00d7"]),
      ]),
      lightbox.prev = el("button", {
        class: "rsdw-lightbox__nav rsdw-lightbox__nav--prev",
        type: "button",
        "aria-label": "Previous image",
        onclick: function (e) { e.stopPropagation(); navigate(-1); },
      }, ["\u2039"]),
      lightbox.img,
      lightbox.next = el("button", {
        class: "rsdw-lightbox__nav rsdw-lightbox__nav--next",
        type: "button",
        "aria-label": "Next image",
        onclick: function (e) { e.stopPropagation(); navigate(1); },
      }, ["\u203a"]),
    ]);
    lightbox.el.addEventListener("click", function (e) {
      if (e.target === lightbox.el) closeLightbox();
    });
    document.body.appendChild(lightbox.el);
    document.addEventListener("keydown", function (e) {
      if (lightbox.el.hidden) return;
      if (e.key === "Escape") closeLightbox();
      if (e.key === "ArrowLeft") navigate(-1);
      if (e.key === "ArrowRight") navigate(1);
    });
  }

  function openLightbox(data, imgs, index) {
    ensureLightbox();
    lightbox.data = data;
    lightbox.imgs = imgs;
    lightbox.index = index || 0;
    drawLightbox();
    lightbox.el.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function drawLightbox() {
    var name = lightbox.data.name || slug;
    var src = joinPath(lightbox.imgs[lightbox.index]);
    lightbox.title.textContent = name;
    lightbox.img.src = src;
    lightbox.img.alt = name;
    lightbox.counter.textContent = lightbox.imgs.length > 1
      ? (lightbox.index + 1) + " / " + lightbox.imgs.length
      : "";
    var multi = lightbox.imgs.length > 1;
    lightbox.prev.hidden = !multi;
    lightbox.next.hidden = !multi;
  }

  function navigate(delta) {
    if (lightbox.imgs.length < 2) return;
    lightbox.index = (lightbox.index + delta + lightbox.imgs.length) % lightbox.imgs.length;
    drawLightbox();
  }

  function closeLightbox() {
    if (!lightbox.el) return;
    lightbox.el.hidden = true;
    document.body.style.overflow = "";
  }

  function init() {
    fetch(folder + "/build.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(render)
      .catch(function (err) {
        console.error("[detail] load failed:", err);
        var host = document.getElementById("rsdw-detail");
        if (host) host.replaceChildren(el("p", { class: "rsdw-empty" }, ["Could not load this entry."]));
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
