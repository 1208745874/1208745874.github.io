/* ================================================================
   js/core.js — 与 DOM 无关的纯函数
   ----------------------------------------------------------------
   这一层只做数据计算、格式化和安全处理，方便：
   1. main.js 复用；
   2. Node 内置的 node:test 直接测试，不需要任何依赖；
   3. 以后换渲染层时继续使用。
   ================================================================ */
(function (global) {
  "use strict";

  /**
   * 把配置里的日期转成 Date。
   * new Date("2026-01-10") 会按 UTC 零点解析，而页面展示用本地时间；
   * 在东八区，“当天发布”的文章会变成“8 小时前”。
   * 因此纯日期字符串统一补本地零点。
   */
  function parseDate(value) {
    if (value instanceof Date) return value;

    const text = String(value == null ? "" : value);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);

    return new Date(dateOnly ? text + "T00:00:00" : text);
  }

  /** 把 {n} / {count} 之类的占位符替换掉。 */
  function formatTemplate(template, values) {
    return String(template == null ? "" : template).replace(/\{(\w+)\}/g, (match, key) => {
      const value = values && values[key];
      return value == null ? match : String(value);
    });
  }

  /**
   * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前。
   * 具体措辞由调用方传入，方便以后做多语言。
   * now 参数让测试可以注入固定时间。
   */
  function relativeTime(dateStr, text, now = Date.now()) {
    const date = parseDate(dateStr);
    if (Number.isNaN(date.getTime())) return String(dateStr || "");

    const templates = text || {};
    const diffSec = Math.floor((now - date.getTime()) / 1000);

    if (diffSec < 60) return templates.justNow || "刚刚";
    if (diffSec < 3600) {
      return formatTemplate(templates.minutes || "{n} 分钟前", {
        n: Math.floor(diffSec / 60)
      });
    }
    if (diffSec < 86400) {
      return formatTemplate(templates.hours || "{n} 小时前", {
        n: Math.floor(diffSec / 3600)
      });
    }
    if (diffSec < 86400 * 30) {
      return formatTemplate(templates.days || "{n} 天前", {
        n: Math.floor(diffSec / 86400)
      });
    }
    if (diffSec < 86400 * 365) {
      return formatTemplate(templates.months || "{n} 个月前", {
        n: Math.floor(diffSec / (86400 * 30))
      });
    }

    return formatTemplate(templates.years || "{n} 年前", {
      n: Math.floor(diffSec / (86400 * 365))
    });
  }

  // HTML 转义表。标题、摘要、标签、联系方式都来自数据/配置，
  // 渲染前必须转义。
  const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
  }

  // 把搜索关键词转成安全的 RegExp 片段。
  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * 收藏键：Hexo 文章用 post.source（如 "_posts/xxx.md"）。
   * 只做基本合法性校验，不做数字转换。
   */
  function normalizeFavoriteKey(value) {
    const text = String(value == null ? "" : value).trim();

    if (!text) return null;
    if (text.length > 512) return null;
    if (/[\u0000-\u001f\u007f]/.test(text)) return null;

    return text;
  }

  const NUMBER_FORMAT = new Intl.NumberFormat("zh-CN");

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? NUMBER_FORMAT.format(number) : "0";
  }

  // 中文标题排序：优先使用带 pinyin 排序规则的 Collator，
  // 不支持时退回普通中文 Collator。
  let titleCollator;
  try {
    titleCollator = new Intl.Collator("zh-Hans-CN-u-co-pinyin", { sensitivity: "base" });
  } catch (e) {
    titleCollator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base" });
  }

  function compareTitles(a, b) {
    return titleCollator.compare(String(a.title || ""), String(b.title || ""));
  }

  /**
   * 返回排好序的新数组，不修改传入的列表。
   * @param {Array} list 每项至少包含 date / title / views
   * @param {string} key latest | views | title
   */
  function sortEntries(list, key) {
    const result = [...list];

    if (key === "views") {
      result.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
    } else if (key === "title") {
      result.sort(compareTitles);
    } else {
      result.sort((a, b) => parseDate(b.date) - parseDate(a.date));
    }

    return result;
  }

  function debounce(fn, wait = 150) {
    let timer = 0;

    return function (...args) {
      const context = this;
      global.clearTimeout(timer);
      timer = global.setTimeout(() => fn.apply(context, args), wait);
    };
  }

  /**
   * 解析 CSS 时间值。--transition-duration 可能是 0.3s 或 300ms，
   * 不能简单 parseFloat 后一律乘 1000。
   */
  function parseCssTime(value) {
    const text = String(value == null ? "" : value).trim();
    const number = parseFloat(text);
    if (!Number.isFinite(number)) return 300;

    if (/ms$/i.test(text)) return number;
    if (/s$/i.test(text)) return number * 1000;
    return 300;
  }

  /**
   * 只允许 http / https / mailto 链接，避免数据里的 javascript: 被塞进 href。
   * 无效链接统一返回 "#"。
   */
  function safeUrl(value) {
    try {
      const base = global.location && global.location.href
        ? global.location.href
        : "http://localhost/";
      const url = new URL(String(value), base);

      return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : "#";
    } catch (e) {
      return "#";
    }
  }

  const BlogCore = {
    parseDate,
    formatTemplate,
    relativeTime,
    escapeHTML,
    escapeRegExp,
    normalizeFavoriteKey,
    formatNumber,
    compareTitles,
    sortEntries,
    debounce,
    parseCssTime,
    safeUrl
  };

  // 浏览器：挂在全局供 main.js 使用；Node：支持 require 做单元测试。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = BlogCore;
  }

  global.BlogCore = BlogCore;
})(typeof globalThis !== "undefined" ? globalThis : this);
