/* RSDWTools shared header injector.
 *
 * Renders the fixed header (logo + brand + center page title + Discord/GitHub
 * links + Tools dropdown) into <div id="rsdw-header-mount"></div>, and the
 * footer into <div id="rsdw-footer-mount"></div>.
 *
 * Tool pages indicate their identity with `<body data-tool="item-editor">`,
 * which lets us highlight the active entry in the tools menu and label the
 * page title in the header center. The landing page uses `data-tool="home"`
 * which renders "Home" as the page title.
 */
(function () {
  "use strict";

  // Single source of truth for the tools list. Order = display order in
  // both the dropdown menu and the landing-page tile grid.
  // `pageLabel` shows in the header center on that tool's page.
  var TOOLS = [
    {
      id: "builds",
      name: "Builds",
      pageLabel: "Builds",
      desc: "Full builds created by the community.",
      href: "/builds/",
      icon: "/shared/assets/page-icons/Builds.png",
    },
    {
      id: "prefabs",
      name: "Prefabs",
      pageLabel: "Prefabs",
      desc: "Prefabs created by the community.",
      href: "/prefabs/",
      icon: "/shared/assets/page-icons/Prefabs.png",
    },
    {
      id: "base-builder",
      name: "Base Builder",
      pageLabel: "Base Builder",
      desc: "Create Bases in Blender",
      href: "https://www.nexusmods.com/runescapedragonwilds/mods/231",
      icon: "/shared/assets/page-icons/BaseBuilder.png",
      external: true,
    },
    {
      id: "dev-kit",
      name: "Dev Kit",
      pageLabel: "Dev Kit",
      desc: "RSDW Dev Kit is required to import/export builds.",
      href: "https://www.nexusmods.com/runescapedragonwilds/mods/238",
      icon: "/shared/assets/logo.png",
      external: true,
    },
    {
      id: "submit",
      name: "Submit",
      pageLabel: "Submit",
      desc: "Submit a Build or a Prefab",
      href: "/submit/",
      icon: "/shared/assets/page-icons/Submit.png",
    },
  ];

  var REPO_URL = "https://github.com/RSDWArchive/RSDWBuilds";
  var DISCORD_LINKS = [
    { name: "Official", href: "https://discord.com/invite/rsdragonwilds" },
    { name: "Wiki", href: "https://discord.com/invite/rsdwwiki" },
    { name: "Creative & Sharing", href: "https://discord.gg/hPJfrZxPss" },
  ];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else {
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

  function pageLabelFor(activeTool) {
    if (!activeTool || activeTool === "home") return "Home";
    for (var i = 0; i < TOOLS.length; i++) {
      if (TOOLS[i].id === activeTool) return TOOLS[i].pageLabel || TOOLS[i].name;
    }
    return "";
  }

  function renderHeader(activeTool) {
    var header = el("header", { class: "rsdw-header", role: "banner" });

    var brand = el(
      "a",
      { class: "rsdw-brand", href: "/", "aria-label": "RSDWBuilds home" },
      [
        el("span", { class: "rsdw-brand__logo" }, [
          el("img", { src: "/shared/assets/logo.png", alt: "" }),
        ]),
        el("span", { class: "rsdw-brand__title" }, ["RSDW Builds"]),
      ]
    );
    header.appendChild(brand);

    var body = document.body;
    var searchPlaceholder = body.getAttribute("data-search-placeholder");
    if (searchPlaceholder !== null) {
      var searchWrap = el("div", { class: "rsdw-header-search" }, [
        el("label", { class: "rsdw-sr", for: "rsdw-search" }, ["Search"]),
        el("input", {
          id: "rsdw-search",
          class: "rsdw-header-search__input",
          type: "search",
          placeholder: searchPlaceholder || "Search...",
          autocomplete: "off",
          spellcheck: "false",
        }),
      ]);
      header.appendChild(searchWrap);
    } else {
      var pageTitle = el("div", { class: "rsdw-page-title" }, [
        pageLabelFor(activeTool),
      ]);
      header.appendChild(pageTitle);
    }

    var actions = el("div", { class: "rsdw-actions" });

    var discordWrap = el("div", { class: "rsdw-tools" });
    var discordToggle = el(
      "button",
      {
        class: "rsdw-iconbtn",
        id: "rsdw-discord-toggle",
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-label": "Open Discord menu",
        title: "Discord",
      },
      [el("img", { src: "/shared/assets/tool-icons/discord.png", alt: "" })]
    );
    var discordMenu = el(
      "div",
      { class: "rsdw-tools__menu", id: "rsdw-discord-menu", role: "menu", hidden: "" },
      DISCORD_LINKS.map(function (d) {
        return el(
          "a",
          {
            href: d.href,
            role: "menuitem",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          [d.name]
        );
      })
    );
    discordWrap.appendChild(discordToggle);
    discordWrap.appendChild(discordMenu);
    actions.appendChild(discordWrap);

    actions.appendChild(
      el(
        "a",
        {
          class: "rsdw-iconbtn",
          href: REPO_URL,
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": "Open GitHub repository",
          title: "GitHub",
        },
        [el("img", { src: "/shared/assets/github.svg", alt: "" })]
      )
    );

    var toolsWrap = el("div", { class: "rsdw-tools" });
    var toggle = el(
      "button",
      {
        class: "rsdw-iconbtn",
        id: "rsdw-tools-toggle",
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-label": "Open tools menu",
        title: "Tools",
      },
      [el("img", { src: "/shared/assets/tools-menu.png", alt: "" })]
    );
    var menuChildren = TOOLS.map(function (t) {
      var attrs = { href: t.href, role: "menuitem" };
      if (t.external) {
        attrs.target = "_blank";
        attrs.rel = "noopener noreferrer";
      }
      if (t.id === activeTool) attrs.class = "is-active";
      return el("a", attrs, [el("img", { src: t.icon, alt: "" }), t.name]);
    });
    var menu = el(
      "div",
      { class: "rsdw-tools__menu", id: "rsdw-tools-menu", role: "menu", hidden: "" },
      menuChildren
    );
    toolsWrap.appendChild(toggle);
    toolsWrap.appendChild(menu);
    actions.appendChild(toolsWrap);

    header.appendChild(actions);

    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) {
        discordMenu.hidden = true;
        discordToggle.setAttribute("aria-expanded", "false");
      }
    });
    discordToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = discordMenu.hidden;
      discordMenu.hidden = !open;
      discordToggle.setAttribute("aria-expanded", String(open));
      if (open) {
        menu.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("click", function (e) {
      if (!toolsWrap.contains(e.target) && !menu.hidden) {
        menu.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
      if (!discordWrap.contains(e.target) && !discordMenu.hidden) {
        discordMenu.hidden = true;
        discordToggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!menu.hidden) {
          menu.hidden = true;
          toggle.setAttribute("aria-expanded", "false");
          toggle.focus();
        }
        if (!discordMenu.hidden) {
          discordMenu.hidden = true;
          discordToggle.setAttribute("aria-expanded", "false");
          discordToggle.focus();
        }
      }
    });

    return header;
  }

  function renderFooter() {
    return el("footer", { class: "rsdw-footer" }, [
      el("p", null, ["Game files & assets are property of Jagex Ltd."]),
      el("p", null, [
        el("a", { href: "https://rsdwarchive.com", target: "_blank", rel: "noopener" }, [
          "Archive",
        ]),
        " \u2014 ",
        el("a", { href: "/" }, ["Builds"]),
        " \u2014 ",
        el("a", { href: "https://rsdwtools.com", target: "_blank", rel: "noopener" }, [
          "Tools",
        ]),
      ]),
    ]);
  }

  function init() {
    document.documentElement.classList.add("rsdw");
    var body = document.body;
    var activeTool = body.getAttribute("data-tool") || "";

    var headerMount = document.getElementById("rsdw-header-mount");
    var footerMount = document.getElementById("rsdw-footer-mount");
    if (headerMount) headerMount.replaceWith(renderHeader(activeTool));
    else document.body.insertBefore(renderHeader(activeTool), document.body.firstChild);
    if (footerMount) footerMount.replaceWith(renderFooter());
  }

  // Expose tools list for landing page renderer.
  window.RSDW_TOOLS = TOOLS;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
