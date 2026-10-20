/* ================================================================
   js/main.js — 全站交互增强
   ----------------------------------------------------------------
   页面内容由 Hexo/EJS 在构建时输出，这一层只负责：
   1. 主题切换；
   2. 收藏（localStorage + 内存 Set + 跨标签同步 + bfcache）；
   3. 相对时间；
   4. 顶部动画、回到顶部；
   5. 文章列表的搜索/排序/标签/只看收藏；
   6. 文章详情页的返回、收藏、正文搜索高亮。

   页面类型由 <body data-page="..."> 声明；每个 init 函数仍然会
   检查自己的容器，找不到就安全返回。
   ================================================================ */
(function () {
  "use strict";

  const BlogCore = window.BlogCore;
  if (!BlogCore) {
    console.error("[blog] js/core.js 未加载，页面交互无法启用。");
    return;
  }

  const {
    escapeHTML,
    escapeRegExp,
    normalizeFavoriteKey,
    relativeTime,
    sortEntries,
    debounce,
    parseCssTime,
    formatTemplate
  } = BlogCore;

  const SITE = window.PIERCE_SITE || {};
  const CFG = SITE.theme || {};
  const SITE_INFO = SITE.site || {};
  const PAGE = document.body.dataset.page || "";

  /* ================================================================
     0. 常量与运行时状态
     ================================================================ */

  // theme 必须是原始字符串 "dark" / "light"，
  // 因为 <head> 里的防闪烁内联脚本会直接读取它。
  const THEME_KEY = "theme";
  const FAV_KEY = "blog_favorites";
  const ANIMATION_KEY = "animation_start_time";
  const THEME_TRANSITION_GRACE_MS = 40;

  let currentSort = "latest";
  let currentTag = "all";
  let searchQuery = "";
  let onlyFavorites = false;

  // 列表页卡片缓存：{ el, date, title, views, search, tags, favKey }
  let cards = [];

  // 详情页正文原始 HTML，用于清空搜索时还原被 <mark> 包裹的内容。
  let originalContentHTML = "";
  let postSearchBound = false;
  let postSearchKeyword = "";

  // 主题过渡定时器，连续点击时用来取消上一次的清理任务。
  let themeTimer = 0;

  /* ================================================================
     1. 基础设施
     ================================================================ */

  /**
   * 安全解析存储区域。
   * 在某些隐私模式或沙箱 iframe 中，访问 window.localStorage 本身就会抛异常，
   * 所以不能把它放在默认参数里直接求值。
   */
  function resolveStorageArea(area) {
    try {
      return area === "session" ? window.sessionStorage : window.localStorage;
    } catch (e) {
      return null;
    }
  }

  /**
   * 对 localStorage / sessionStorage 的统一封装。
   * 隐私模式、配额满、被浏览器策略禁用时，读写都可能抛异常；
   * 这里全部静默降级，避免一个存储异常导致整页脚本中断。
   */
  const storage = {
    getRaw(key, area = "local") {
      const target = resolveStorageArea(area);
      if (!target) return null;

      try {
        return target.getItem(key);
      } catch (e) {
        return null;
      }
    },

    setRaw(key, value, area = "local") {
      const target = resolveStorageArea(area);
      if (!target) return false;

      try {
        target.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    },

    getJSON(key, fallback, area = "local") {
      const raw = storage.getRaw(key, area);
      if (raw === null) return fallback;

      try {
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },

    setJSON(key, value, area = "local") {
      try {
        return storage.setRaw(key, JSON.stringify(value), area);
      } catch (e) {
        return false;
      }
    }
  };

  // 按 "a.b.c" 路径安全读取主题配置，任何一层缺失都返回 fallback。
  function cfg(path, fallback = "") {
    const parts = String(path).split(".");
    let node = CFG;

    for (const part of parts) {
      if (node == null) return fallback;
      node = node[part];
    }

    return node == null ? fallback : node;
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function safeRun(name, fn) {
    try {
      fn();
    } catch (error) {
      console.error(`[blog] ${name} 初始化失败`, error);
    }
  }

  /* ================================================================
     2. 主题切换
     ================================================================ */

  function updateThemeSwitch() {
    const switchEl = document.getElementById("themeSwitch");
    if (!switchEl) return;

    const isDark = document.documentElement.classList.contains("dark");
    const label = cfg("themeSwitch.label", "切换主题");

    switchEl.setAttribute("aria-checked", String(isDark));
    switchEl.setAttribute("aria-label", label);
    switchEl.title = label;
  }

  // 让移动端浏览器地址栏颜色跟随主题。
  function updateThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    const color = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--bg-body")
      .trim();

    if (color) meta.setAttribute("content", color);
  }

  /**
   * 切换主题。
   * animate 时给 <html> 挂一次性过渡类；持久化失败也不影响当前会话。
   */
  function setTheme(isDark, options = {}) {
    const animate = options.animate !== false;
    const persist = options.persist !== false;
    const root = document.documentElement;

    if (animate && !prefersReducedMotion()) {
      root.classList.add("theme-transitioning");

      // 强制一次样式计算，让浏览器先记录“旧颜色 + 新过渡规则”。
      void root.offsetWidth;

      const duration = parseCssTime(
        window.getComputedStyle(root).getPropertyValue("--transition-duration")
      );
      const waitMs = duration + THEME_TRANSITION_GRACE_MS;

      window.clearTimeout(themeTimer);
      themeTimer = window.setTimeout(() => {
        root.classList.remove("theme-transitioning");
      }, waitMs);
    }

    root.classList.toggle("dark", isDark);

    if (persist) {
      storage.setRaw(THEME_KEY, isDark ? "dark" : "light");
    }

    updateThemeSwitch();
    updateThemeColor();
  }

  function syncThemeFromStorage() {
    const value = storage.getRaw(THEME_KEY);

    if (value === "dark") {
      setTheme(true, { animate: true, persist: false });
    } else if (value === "light" || value === null) {
      setTheme(false, { animate: true, persist: false });
    }
  }

  function initTheme() {
    const switchEl = document.getElementById("themeSwitch");
    if (!switchEl) return;

    updateThemeSwitch();
    updateThemeColor();

    switchEl.addEventListener("click", () => {
      const isDark = !document.documentElement.classList.contains("dark");
      setTheme(isDark);
    });
  }

  /* ================================================================
     3. 收藏
     ================================================================ */

  /**
   * 读取收藏键列表。
   * 兼容历史数据：过滤空值、控制字符、重复项。
   */
  function readFavoritesFromStorage() {
    const list = storage.getJSON(FAV_KEY, []);
    if (!Array.isArray(list)) return [];

    return Array.from(
      new Set(list.map(item => normalizeFavoriteKey(item)).filter(Boolean))
    );
  }

  // 以内存 Set 为准，localStorage 只是持久化副本。
  // 这样即使隐私模式禁止写入，本次会话里的收藏仍然能正常工作。
  let favoriteKeys = new Set(readFavoritesFromStorage());

  function saveFavorites() {
    return storage.setJSON(FAV_KEY, [...favoriteKeys]);
  }

  function isFavorited(key) {
    const normalized = normalizeFavoriteKey(key);
    return normalized !== null && favoriteKeys.has(normalized);
  }

  function toggleFavorite(key) {
    const normalized = normalizeFavoriteKey(key);
    if (normalized === null) return;

    if (favoriteKeys.has(normalized)) favoriteKeys.delete(normalized);
    else favoriteKeys.add(normalized);

    saveFavorites();
  }

  /**
   * 把收藏状态同步到按钮的视觉与无障碍属性。
   * 卡片、详情页、bfcache 恢复都复用这一个函数。
   */
  function updateFavoriteButton(button, key) {
    if (!button) return;

    const card = CFG.card || {};
    const favorited = isFavorited(key);
    const label = favorited ? (card.favTitleOn || "取消收藏") : (card.favTitleOff || "收藏");
    const icon = favorited ? (card.favOn || "★") : (card.favOff || "☆");

    button.classList.toggle("active", favorited);
    button.innerHTML = `<span aria-hidden="true">${escapeHTML(icon)}</span>`;
    button.title = label;
    button.setAttribute("aria-pressed", String(favorited));
    button.setAttribute("aria-label", label);
  }

  // 收藏变化后，把当前页面所有相关 UI 同步一遍。
  function refreshFavorites() {
    document.querySelectorAll("[data-fav-key]").forEach(button => {
      if (
        button.classList.contains("fav-btn") ||
        button.classList.contains("post-fav-btn")
      ) {
        updateFavoriteButton(button, button.dataset.favKey);
      }
    });

    if (document.getElementById("postsGrid")) {
      filterCards();
    }
  }

  /* ================================================================
     4. 相对时间
     ================================================================ */

  /**
   * 服务端先输出绝对日期；这里再改成“相对时间（· 绝对日期）”。
   * 禁用 JS 时用户看到的仍然是准确的绝对日期。
   */
  function initRelativeTimes() {
    const templates = CFG.relativeTime || {};

    document.querySelectorAll("time[datetime]").forEach(timeEl => {
      const raw = timeEl.getAttribute("datetime");
      const absolute = timeEl.textContent.trim();
      const relative = relativeTime(raw, templates);

      if (!relative || relative === raw) return;

      timeEl.setAttribute("title", absolute);

      if (timeEl.closest(".post-date")) {
        timeEl.textContent = relative + " · " + absolute;
      } else {
        timeEl.textContent = relative;
      }
    });
  }

  /* ================================================================
     5. 顶部动画 / 回到顶部
     ================================================================ */

  /**
   * 顶部动画。
   * 用 sessionStorage 记录起始时间戳，按“绝对时间取模”切帧，
   * 这样页面跳转后动画会接着上一页的相位播放，而不是从第一帧重来。
   */
  function initAnimation() {
    const frames = document.querySelectorAll(".animation-frame");
    if (!frames.length) return;

    if (frames.length === 1) {
      frames[0].classList.add("active");
      return;
    }

    const interval = Number(cfg("animation.interval", 900)) || 900;
    let startTime = parseInt(storage.getRaw(ANIMATION_KEY, "session"), 10);

    // 没有记录、记录损坏、或系统时间被回拨时，重新开始计时。
    if (!Number.isFinite(startTime) || startTime <= 0 || startTime > Date.now()) {
      startTime = Date.now();
      storage.setRaw(ANIMATION_KEY, String(startTime), "session");
    }

    const tick = () => {
      const elapsed = Date.now() - startTime;
      const index = Math.floor(elapsed / interval) % frames.length;

      frames.forEach((frame, i) => frame.classList.toggle("active", i === index));

      // 精确安排下一次切换，避免 setInterval 累积漂移。
      const nextTime = startTime + (Math.floor(elapsed / interval) + 1) * interval;
      window.setTimeout(tick, Math.max(0, nextTime - Date.now()));
    };

    tick();
  }

  function initBackToTop() {
    const button = document.getElementById("backToTop");
    if (!button) return;

    const threshold = Number(cfg("backToTop.threshold", 300)) || 300;

    button.addEventListener("click", () => {
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth"
      });
    });

    const update = () => {
      button.classList.toggle("show", window.scrollY > threshold);
    };

    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  /* ================================================================
     6. 文章列表页
     ================================================================ */

  function readCard(element) {
    let tags = [];

    try {
      const parsed = JSON.parse(element.dataset.tags || "[]");
      if (Array.isArray(parsed)) tags = parsed;
    } catch (e) {
      tags = [];
    }

    return {
      el: element,
      date: element.dataset.date || "",
      title: element.dataset.title || "",
      views: Number(element.dataset.views) || 0,
      search: String(element.dataset.search || "").toLowerCase(),
      tags,
      favKey: element.dataset.favKey || ""
    };
  }

  function updateSortButtons() {
    const container = document.getElementById("sortButtons");
    if (!container) return;

    container.querySelectorAll(".sort-btn").forEach(button => {
      const active = button.dataset.sort === currentSort;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function updateTagBarState() {
    const container = document.getElementById("tagsFilter");
    if (!container) return;

    container.querySelectorAll(".tag-btn").forEach(button => {
      const active = button.dataset.tag === currentTag;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    const favToggle = document.getElementById("tagFavToggle");
    if (!favToggle) return;

    const tagBar = CFG.tagBar || {};
    const label = onlyFavorites
      ? (tagBar.favTitleOn || "取消「只看已收藏」筛选")
      : (tagBar.favTitleOff || "只看已收藏");

    favToggle.classList.toggle("active", onlyFavorites);
    favToggle.textContent = onlyFavorites
      ? (tagBar.favIconOn || "★")
      : (tagBar.favIconOff || "☆");
    favToggle.title = label;
    favToggle.setAttribute("aria-label", label);
    favToggle.setAttribute("aria-pressed", String(onlyFavorites));
  }

  /** 按当前排序键重排已有卡片，不重建 DOM。 */
  function applySort() {
    const grid = document.getElementById("postsGrid");
    if (!grid) return;

    const sorted = sortEntries(cards, currentSort);
    sorted.forEach(item => grid.appendChild(item.el));
  }

  /** 按搜索词、标签、只看收藏过滤卡片。 */
  function filterCards() {
    const query = searchQuery.trim().toLowerCase();
    let visible = 0;

    cards.forEach(item => {
      const matchTag = currentTag === "all" || item.tags.includes(currentTag);
      const matchSearch = !query || item.search.includes(query);
      const matchFavorite = !onlyFavorites || favoriteKeys.has(item.favKey);
      const show = matchTag && matchSearch && matchFavorite;

      item.el.hidden = !show;
      if (show) visible++;
    });

    const postsCfg = CFG.postsPage || {};
    const resultEl = document.getElementById("postsResultCount");
    const emptyEl = document.getElementById("postsEmptyState");

    if (resultEl) {
      resultEl.textContent = visible
        ? formatTemplate(postsCfg.resultText || "共 {count} 篇文章", { count: visible })
        : (postsCfg.emptyText || "没有找到匹配的文章");
    }

    if (emptyEl) {
      emptyEl.hidden = visible > 0;
    }
  }

  /** 从 URL 读回筛选状态，刷新、分享、返回都不丢。 */
  function readStateFromURL() {
    const params = new URLSearchParams(window.location.search);
    const options = (CFG.postsPage && CFG.postsPage.sort) || [];
    const sortKeys = options.map(option => option.key);
    const sort = params.get("sort");

    currentSort = sortKeys.includes(sort) ? sort : (sortKeys[0] || "latest");
    currentTag = params.get("tag") || "all";
    searchQuery = params.get("q") || "";
    onlyFavorites = params.get("fav") === "1";

    // 数据更新后当前标签可能已不存在，回退到“全部”。
    if (
      currentTag !== "all" &&
      !cards.some(card => card.tags.includes(currentTag))
    ) {
      currentTag = "all";
    }
  }

  /** 把筛选状态写回 URL，使用 replaceState 避免污染历史栈。 */
  function syncURL() {
    if (!document.getElementById("postsGrid")) return;

    const options = (CFG.postsPage && CFG.postsPage.sort) || [];
    const defaultSort = options[0] ? options[0].key : "latest";
    const params = new URLSearchParams(window.location.search);

    if (searchQuery) params.set("q", searchQuery);
    else params.delete("q");

    if (currentTag !== "all") params.set("tag", currentTag);
    else params.delete("tag");

    if (currentSort !== defaultSort) params.set("sort", currentSort);
    else params.delete("sort");

    if (onlyFavorites) params.set("fav", "1");
    else params.delete("fav");

    const qs = params.toString();
    const next = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;

    try {
      window.history.replaceState(null, "", next);
    } catch (e) {
      /* file:// 或受限环境下忽略 */
    }
  }

  function initSortButtons() {
    const container = document.getElementById("sortButtons");
    if (!container) return;

    container.addEventListener("click", event => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const button = target.closest(".sort-btn");
      if (!button) return;

      currentSort = button.dataset.sort || "latest";
      updateSortButtons();
      applySort();
      syncURL();
    });
  }

  function initTagBar() {
    const container = document.getElementById("tagsFilter");
    if (!container) return;

    container.addEventListener("click", event => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const tagButton = target.closest(".tag-btn");
      if (tagButton) {
        currentTag = tagButton.dataset.tag || "all";
        updateTagBarState();
        filterCards();
        syncURL();
        return;
      }

      if (target.closest("#tagFavToggle")) {
        onlyFavorites = !onlyFavorites;
        updateTagBarState();
        filterCards();
        syncURL();
      }
    });
  }

  function initPostsPage() {
    const grid = document.getElementById("postsGrid");
    if (!grid) return;

    cards = Array.from(grid.querySelectorAll(".article-card")).map(readCard);

    readStateFromURL();

    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
      searchInput.value = searchQuery;
      searchInput.addEventListener(
        "input",
        debounce(() => {
          searchQuery = searchInput.value.trim();
          filterCards();
          syncURL();
        }, 150)
      );
    }

    initSortButtons();
    initTagBar();
    updateSortButtons();
    updateTagBarState();
    applySort();
    filterCards();
    syncURL();
  }

  /* ================================================================
     7. 文章详情页
     ================================================================ */

  /** 返回列表：只有来源页确实是列表/归档/标签页时才 history.back()。 */
  function goBackToPosts() {
    let referrerPath = "";

    try {
      if (document.referrer) {
        const referrer = new URL(document.referrer);
        if (referrer.origin === window.location.origin) {
          referrerPath = referrer.pathname.replace(/index\.html$/, "");
        }
      }
    } catch (e) {
      referrerPath = "";
    }

    const fromList =
      referrerPath === "/" ||
      referrerPath === "/posts/" ||
      referrerPath.indexOf("/tags/") === 0 ||
      referrerPath.indexOf("/archives/") === 0 ||
      referrerPath.indexOf("/categories/") === 0;

    const backUrl = (CFG.post && CFG.post.backUrl) || SITE_INFO.postsUrl || "/posts/";

    if (fromList && window.history.length > 1) window.history.back();
    else window.location.href = backUrl;
  }

  /**
   * 在 root 的文本节点中高亮关键词，返回命中次数。
   * 跳过 script / style / 已有的 mark，避免破坏正文结构。
   */
  function highlightText(root, keyword) {
    if (!keyword) return 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;

        const parent = node.parentNode;
        if (parent && /^(SCRIPT|STYLE|MARK)$/i.test(parent.nodeName)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    let total = 0;

    textNodes.forEach(textNode => {
      const text = textNode.nodeValue;
      const regex = new RegExp(escapeRegExp(keyword), "gi");
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = match[0];
        fragment.appendChild(mark);

        lastIndex = match.index + match[0].length;
        total++;
      }

      // 没有命中就不替换节点，减少无意义的 DOM 操作。
      if (lastIndex === 0) return;
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode.replaceChild(fragment, textNode);
    });

    return total;
  }

  /**
   * 绑定详情页正文搜索。
   * 每次输入先还原原始 HTML，再重新高亮，避免 <mark> 嵌套。
   */
  function initPostSearch() {
    if (postSearchBound) return;

    const input = document.getElementById("postSearch");
    const countEl = document.getElementById("postSearchCount");
    const container = document.getElementById("postContent");
    if (!input || !container) return;

    postSearchBound = true;
    input.value = "";
    postSearchKeyword = "";
    if (countEl) countEl.textContent = "";

    input.addEventListener(
      "input",
      debounce(() => {
        const keyword = input.value.trim();
        if (keyword === postSearchKeyword) return;
        postSearchKeyword = keyword;

        container.innerHTML = originalContentHTML;

        if (!keyword) {
          if (countEl) countEl.textContent = "";
          return;
        }

        const count = highlightText(container, keyword);
        if (countEl) {
          countEl.textContent = count > 0
            ? formatTemplate(cfg("post.foundText", "找到 {count} 处"), { count })
            : cfg("post.notFoundText", "未找到");
        }
      }, 120)
    );
  }

  function initPostDetail() {
    const contentEl = document.getElementById("postContent");
    if (!contentEl) return;

    originalContentHTML = contentEl.innerHTML;

    const backButton = document.getElementById("backBtn");
    if (backButton) {
      backButton.addEventListener("click", goBackToPosts);
    }

    const favButton = document.getElementById("postFavBtn");
    if (favButton && favButton.dataset.favKey) {
      updateFavoriteButton(favButton, favButton.dataset.favKey);
    }

    initPostSearch();
  }

  /* ================================================================
     8. 全局事件与存储同步
     ================================================================ */

  /**
   * 全局事件委托。
   * 列表排序/过滤只移动已有 DOM，不需要重新绑定收藏事件。
   */
  function initGlobalClicks() {
    document.addEventListener("click", event => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const favButton = target.closest(".fav-btn, .post-fav-btn");
      if (!favButton) return;

      event.preventDefault();
      event.stopPropagation();

      if (favButton.disabled) return;

      const key = normalizeFavoriteKey(favButton.dataset.favKey);
      if (key === null) return;

      toggleFavorite(key);
      updateFavoriteButton(favButton, key);

      // “只看已收藏”筛选开启时，取消收藏后让卡片立即消失。
      if (document.getElementById("postsGrid") && onlyFavorites && !isFavorited(key)) {
        filterCards();
      }
    });
  }

  function initStorageSync() {
    window.addEventListener("storage", event => {
      if (event.key === FAV_KEY) {
        favoriteKeys = new Set(readFavoritesFromStorage());
        refreshFavorites();
        return;
      }

      if (event.key === THEME_KEY) {
        if (event.newValue === "dark" || event.newValue === "light") {
          setTheme(event.newValue === "dark", { animate: true, persist: false });
        } else if (event.newValue === null) {
          setTheme(false, { animate: true, persist: false });
        }
      }
    });
  }

  /* ================================================================
     9. 启动与 bfcache
     ================================================================ */

  const PAGE_RENDERERS = {
    posts: initPostsPage,
    post: initPostDetail
  };

  document.addEventListener("DOMContentLoaded", () => {
    safeRun("theme", initTheme);
    safeRun("animation", initAnimation);
    safeRun("backToTop", initBackToTop);
    safeRun("relativeTimes", initRelativeTimes);
    safeRun("globalClicks", initGlobalClicks);
    safeRun("storageSync", initStorageSync);

    const renderer = PAGE_RENDERERS[PAGE];
    if (renderer) safeRun(PAGE, renderer);

    // 服务端只输出“未收藏”的初始状态，这里按 localStorage 恢复所有星标。
    safeRun("favorites", refreshFavorites);
  });

  /**
   * bfcache（浏览器后退缓存）恢复时不会重新触发 DOMContentLoaded，
   * DOM 是旧快照，但 localStorage 可能已经在别的页面被修改。
   * 这里重新同步主题与收藏，保留原有筛选状态。
   */
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;

    favoriteKeys = new Set(readFavoritesFromStorage());
    syncThemeFromStorage();
    refreshFavorites();
  });
})();
