/* ============================================================================
 * MiniChat —— 最基础的 DeepSeek 对话页面
 *
 * 兼容目标：Safari 12 时期的老浏览器（约 2018 年）。
 * 因此本文件严格使用 ES5 语法：
 *   - 不用 let / const / 箭头函数 / 模板字符串 / 解构 / 展开
 *   - 不用 fetch / Promise / async / await（用 XMLHttpRequest）
 *   - 不用 Array.prototype.includes / Object.assign / Element.closest / classList
 * 数据保存在 localStorage；在 Safari 无痕模式等禁用存储的环境里，
 * 自动退化为“仅本次会话有效”的内存存储，功能不受影响。
 * ========================================================================== */
(function () {
  "use strict";

  /* ----------------------------- 常量配置 ------------------------------- */

  var KEY_CONVS = "minichat.conversations.v1";
  var KEY_SETTINGS = "minichat.settings.v1";
  var KEY_CURRENT = "minichat.current.v1";

  var MAX_STORED_MESSAGES = 200;   // 每个对话本地最多保留的消息条数
  var SEND_HISTORY_LIMIT = 30;     // 每次发给模型的最近消息条数（省 token）
  var MAX_CONVERSATIONS = 50;      // 本地最多保留的对话数
  var REQUEST_TIMEOUT = 120000;    // 请求超时（毫秒）
  var STREAM_IDLE_TIMEOUT = 60000; // 流式输出：多久没有新内容就算卡住
  var STREAM_RENDER_INTERVAL = 120;// 流式输出：最快多少毫秒重画一次气泡

  var DEFAULT_SETTINGS = {
    apiKey: "",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    systemPrompt: "",
    rememberKey: true,
    theme: "auto",         /* auto | light | dark */
    settingsOpen: null,    /* true/false = 用户手动选过；null = 自动（没填 Key 就展开） */
    mdEnabled: true,       /* 回答用 Markdown 排版 */
    streaming: true        /* 流式输出（边生成边显示） */
  };

  /* ----------------------------- 存储层 --------------------------------- */
  /* localStorage 可用则用；不可用（无痕模式 / 被禁用）则退化为内存对象。  */

  var memoryStore = {};
  var hasLocalStorage = (function () {
    try {
      var ls = window.localStorage;
      var t = "__minichat_probe__";
      ls.setItem(t, "1");
      ls.removeItem(t);
      return true;
    } catch (e) {
      return false;
    }
  })();

  var quotaWarned = false;

  /* 返回 true 表示确实写进了 localStorage；false 表示走了内存兜底。 */
  function storeSet(key, value) {
    if (hasLocalStorage) {
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch (e) {
        /* 多为 QuotaExceededError（空间满）；调用方可裁剪后重试 */
      }
    }
    memoryStore[key] = value;
    return false;
  }

  function storeGet(key) {
    if (hasLocalStorage) {
      try {
        var v = window.localStorage.getItem(key);
        if (v !== null && v !== undefined) { return v; }
      } catch (e) { /* 忽略，走内存 */ }
    }
    return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
  }

  function storeRemove(key) {
    if (hasLocalStorage) {
      try { window.localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
    }
    delete memoryStore[key];
  }

  function jsonParse(text) {
    if (!text) { return null; }
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /* ----------------------------- 运行状态 ------------------------------- */

  var settings = {};
  var conversations = [];
  var currentId = null;
  var busy = false;
  var activeXhr = null;
  var activeRequestCleanup = null;   /* 当前请求的统一收尾函数（含清空闲定时器） */
  var requestAborted = false;

  /* ----------------------------- DOM 小工具 ----------------------------- */

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) {
      node.appendChild(document.createTextNode(String(text)));
    }
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  var statusTimer = null;

  function setStatus(text, isError) {
    var node = $("status");
    if (!node) { return; }
    /* 颜色交给 CSS 的 .err / .ok，不用内联样式，否则深色模式覆盖不掉 */
    node.className = "status " + (isError ? "err" : "ok");
    node.innerHTML = "";
    if (text) { node.appendChild(document.createTextNode(text)); }
    if (statusTimer) { window.clearTimeout(statusTimer); statusTimer = null; }
    if (text) {
      /* 提示会自动消失：手机上顶栏是固定定位，留着长文案会一直压住消息。
         请求类错误同时会在对话里留下一条红色气泡，不会丢信息。 */
      statusTimer = window.setTimeout(function () {
        node.innerHTML = "";
        syncHeaderSpace();
      }, isError ? 8000 : 4000);
    }
    syncHeaderSpace();
  }

  function nowMs() { return new Date().getTime(); }

  function uid() {
    return "c" + nowMs().toString(36) + Math.floor(Math.random() * 1000000).toString(36);
  }

  function formatTime(ms) {
    var d = new Date(ms);
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function trim(text) { return String(text).replace(/^\s+|\s+$/g, ""); }

  /* --------------------------- 移动端适配 ------------------------------- */
  /* 移动端布局：单列文档流 + 抽屉式侧栏。断点与 style.css 保持一致。 */

  var MOBILE_MAX = 700;
  var autoScroll = true;        /* 本次渲染后是否自动滚到底部 */

  function isMobile() {
    try {
      if (window.matchMedia) {
        return window.matchMedia("(max-width: " + MOBILE_MAX + "px)").matches;
      }
    } catch (e) { /* 忽略，退回按宽度判断 */ }
    return typeof window.innerWidth === "number" ? window.innerWidth <= MOBILE_MAX : false;
  }

  /* 手机顶栏是固定定位，消息区要按它的真实高度留出顶部空间。
     桌面端清掉内联样式，交回 CSS 的绝对定位布局。 */
  function syncHeaderSpace() {
    var box = $("messages");
    if (!box) { return; }
    if (!isMobile()) {
      box.style.paddingTop = "";
      return;
    }
    var head = $("topbar");
    var h = head && head.offsetHeight ? head.offsetHeight : 60;
    box.style.paddingTop = (h + 8) + "px";
  }

  function openDrawer() {
    $("sidebar").className = "open";
    $("overlay").className = "open";
  }
  function closeDrawer() {
    $("sidebar").className = "";
    $("overlay").className = "";
  }
  function toggleDrawer() {
    if (($("sidebar").className || "").indexOf("open") !== -1) { closeDrawer(); }
    else { openDrawer(); }
  }

  function pageOffsetY() {
    var d = document.documentElement, b = document.body;
    return window.pageYOffset ||
      (d ? d.scrollTop : 0) ||
      (b ? b.scrollTop : 0) || 0;
  }

  function docHeight() {
    var d = document.documentElement, b = document.body;
    var h1 = d ? d.scrollHeight : 0;
    var h2 = b ? b.scrollHeight : 0;
    return h1 > h2 ? h1 : h2;
  }

  /* 用户是不是就在底部附近？用于决定新消息来了要不要把视线拉下去。 */
  function isNearBottom() {
    if (isMobile()) {
      var view = typeof window.innerHeight === "number" ? window.innerHeight : 600;
      return (docHeight() - view - pageOffsetY()) < 160;
    }
    var box = $("messages");
    var ch = box.clientHeight || 0;
    return (box.scrollHeight - box.scrollTop - ch) < 60;
  }

  function scrollToBottom() {
    var box = $("messages");
    box.scrollTop = box.scrollHeight;
    /* 移动端页面本身在滚动 */
    if (isMobile()) {
      try { window.scrollTo(0, docHeight()); } catch (e) { /* 忽略 */ }
    }
  }

  /* 「回到底部」浮动按钮：只在手机、且离底部较远时出现 */
  function updateToBottom() {
    var btn = $("toBottom");
    if (!btn) { return; }
    if (!isMobile()) { btn.style.display = "none"; return; }
    btn.style.display = isNearBottom() ? "none" : "block";
  }

  /* ----------------------------- 深色 / 浅色 ---------------------------- */
  /* 只切 html 上的 class，颜色全部写在 CSS 里。
     "跟随系统"依赖 matchMedia("(prefers-color-scheme: dark)")：
     Safari 12.1 以前不认识，那就一直当浅色处理，手动切深色照常可用。 */

  function themeIsDark(mode) {
    if (mode === "dark") { return true; }
    if (mode === "light") { return false; }
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (e) {
      return false;
    }
  }

  /* 顺手改 <meta name="theme-color">，手机状态栏跟着一起变（老浏览器忽略） */
  function updateThemeColorMeta(dark) {
    if (!document.getElementsByTagName) { return; }
    var metas = document.getElementsByTagName("meta");
    var i, m;
    for (i = 0; i < metas.length; i++) {
      m = metas[i];
      if (m.getAttribute && m.getAttribute("name") === "theme-color") {
        m.setAttribute("content", dark ? "#1e2126" : "#f2f4f7");
      }
    }
  }

  function applyTheme() {
    var dark = themeIsDark(settings.theme);
    if (document.documentElement) {
      document.documentElement.className = dark ? "dark" : "light";
    }
    var btn = $("themeBtn");
    if (btn) {
      btn.innerHTML = "";
      btn.appendChild(document.createTextNode(dark ? "☀" : "☾"));
      btn.setAttribute("title", dark ? "切换到浅色" : "切换到深色");
      btn.setAttribute("aria-label", dark ? "切换到浅色" : "切换到深色");
    }
    var sel = $("themeSel");
    if (sel && sel.value !== settings.theme) { sel.value = settings.theme; }
    updateThemeColorMeta(dark);
  }

  function setTheme(mode) {
    settings.theme = (mode === "dark" || mode === "light") ? mode : "auto";
    persistSettings();
    applyTheme();
  }

  /* 跟随系统时，用户在系统里换了外观要跟着变 */
  function bindSystemTheme() {
    try {
      if (!window.matchMedia) { return; }
      var mql = window.matchMedia("(prefers-color-scheme: dark)");
      var handler = function () {
        if (settings.theme === "auto") { applyTheme(); }
      };
      if (mql.addEventListener) { mql.addEventListener("change", handler, false); }
      else if (mql.addListener) { mql.addListener(handler); }
    } catch (e) { /* 老浏览器不支持跟随系统，忽略 */ }
  }

  /* --------------------------- 设置区折叠 ------------------------------- */
  /* 历史对话在上面，设置可以收起来。默认展开还是收起由"有没有填 Key"决定：
     没填就必须让用户看见，填过了就默认收起，进侧栏先看到对话列表。 */

  var settingsOpenSession = null;   /* 本次会话里临时强制展开，不落盘 */

  function settingsIsOpen() {
    if (settingsOpenSession !== null) { return settingsOpenSession; }
    if (settings.settingsOpen === true || settings.settingsOpen === false) {
      return settings.settingsOpen;      /* 用户手动选过，听用户的 */
    }
    return !settings.apiKey;             /* 没填 Key 就展开 */
  }

  function renderSettingsHint() {
    var hint = $("settingsHint");
    if (!hint) { return; }
    hint.innerHTML = "";
    if (!settings.apiKey) {
      hint.appendChild(document.createTextNode("· 需要填写 API Key"));
    }
  }

  function renderSettingsOpen() {
    var open = settingsIsOpen();
    var body = $("settingsBody");
    var head = $("settingsHead");
    var caret = $("settingsCaret");
    if (body) { body.style.display = open ? "block" : "none"; }
    if (caret) {
      caret.innerHTML = "";
      caret.appendChild(document.createTextNode(open ? "▾" : "▸"));
    }
    if (head) {
      head.setAttribute("title", open ? "收起设置" : "展开设置");
      head.setAttribute("aria-expanded", open ? "true" : "false");
    }
    renderSettingsHint();
  }

  function scrollSidebarToSettings() {
    if (!isMobile()) { return; }        /* 桌面端侧栏更高，一般不需要 */
    var sb = $("sidebar"), blk = $("settingsBlock");
    if (!sb || !blk) { return; }
    var top = blk.offsetTop || 0;
    sb.scrollTop = top > 8 ? top - 8 : 0;
  }

  function toggleSettings() {
    var willOpen = !settingsIsOpen();
    settings.settingsOpen = willOpen;   /* 记下用户的选择 */
    settingsOpenSession = null;
    persistSettings();
    renderSettingsOpen();
    if (willOpen) { scrollSidebarToSettings(); }
  }

  /* ----------------------------- 数据读写 ------------------------------- */

  function normalizeSettings(raw) {
    var s = {};
    var k;
    for (k in DEFAULT_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) {
        s[k] = DEFAULT_SETTINGS[k];
      }
    }
    if (raw && typeof raw === "object") {
      for (k in s) {
        if (Object.prototype.hasOwnProperty.call(s, k) &&
            raw[k] !== undefined && raw[k] !== null) {
          s[k] = raw[k];
        }
      }
    }
    s.apiKey = trim(s.apiKey);
    s.baseUrl = trim(s.baseUrl) || DEFAULT_SETTINGS.baseUrl;
    s.model = trim(s.model) || DEFAULT_SETTINGS.model;
    s.rememberKey = !!s.rememberKey;
    if (s.theme !== "dark" && s.theme !== "light" && s.theme !== "auto") {
      s.theme = DEFAULT_SETTINGS.theme;
    }
    if (s.settingsOpen !== true && s.settingsOpen !== false) { s.settingsOpen = null; }
    s.mdEnabled = (s.mdEnabled === false) ? false : true;
    s.streaming = (s.streaming === false) ? false : true;
    return s;
  }

  function normalizeMessages(arr) {
    var out = [];
    var i, m;
    if (!arr || !arr.length) { return out; }
    for (i = 0; i < arr.length; i++) {
      m = arr[i];
      if (!m || typeof m !== "object") { continue; }
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "error") { continue; }
      out.push({
        role: m.role,
        content: typeof m.content === "string" ? m.content : "",
        reasoning: typeof m.reasoning === "string" ? m.reasoning : "",
        /* skip = 该条只用于展示，不参与后续上下文（例如“已停止”） */
        skip: !!m.skip,
        ts: typeof m.ts === "number" ? m.ts : nowMs()
      });
    }
    return out;
  }

  function loadState() {
    settings = normalizeSettings(jsonParse(storeGet(KEY_SETTINGS)));

    var raw = jsonParse(storeGet(KEY_CONVS));
    conversations = [];
    if (raw && raw.length) {
      var i, c;
      for (i = 0; i < raw.length; i++) {
        c = raw[i];
        if (!c || typeof c !== "object") { continue; }
        conversations.push({
          id: typeof c.id === "string" && c.id ? c.id : uid(),
          title: typeof c.title === "string" && c.title ? c.title : "新对话",
          createdAt: typeof c.createdAt === "number" ? c.createdAt : nowMs(),
          updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : nowMs(),
          messages: normalizeMessages(c.messages)
        });
      }
    }

    currentId = storeGet(KEY_CURRENT);
    if (!findConversation(currentId)) {
      currentId = conversations.length ? conversations[0].id : null;
    }
    if (!conversations.length) { createConversation(); }
  }

  function findConversation(id) {
    var i;
    if (!id) { return null; }
    for (i = 0; i < conversations.length; i++) {
      if (conversations[i].id === id) { return conversations[i]; }
    }
    return null;
  }

  function getCurrent() {
    var c = findConversation(currentId);
    if (!c) {
      if (!conversations.length) { c = createConversation(); }
      else { c = conversations[0]; currentId = c.id; }
    }
    return c;
  }

  function createConversation() {
    var c = {
      id: uid(),
      title: "新对话",
      createdAt: nowMs(),
      updatedAt: nowMs(),
      messages: []
    };
    conversations.unshift(c);   /* 新对话排在最前 */
    currentId = c.id;
    storeSet(KEY_CURRENT, currentId);
    return c;
  }

  /* 保存前的消息清洗：空白的“思考中”占位不落盘，pending 标记不落盘 */
  function sanitizeForSave(messages) {
    var out = [];
    var i, m;
    for (i = 0; i < messages.length; i++) {
      m = messages[i];
      if (m.pending && !m.content) { continue; }
      out.push({
        role: m.role,
        content: m.content || "",
        reasoning: m.reasoning || "",
        skip: !!m.skip,
        ts: m.ts
      });
    }
    return out;
  }

  /* 保存对话列表：空间不足时自动丢弃最旧的对话后重试。 */
  function persistConversations() {
    var list = [];
    var i, c, msgs;
    var limit = conversations.length > MAX_CONVERSATIONS ? MAX_CONVERSATIONS : conversations.length;

    for (i = 0; i < limit; i++) {
      c = conversations[i];
      msgs = sanitizeForSave(c.messages);
      if (msgs.length > MAX_STORED_MESSAGES) {
        msgs = msgs.slice(msgs.length - MAX_STORED_MESSAGES);
      }
      list.push({
        id: c.id, title: c.title, createdAt: c.createdAt,
        updatedAt: c.updatedAt, messages: msgs
      });
    }

    /* 当前对话绝不能被裁掉 */
    var keptCurrent = false;
    for (i = 0; i < list.length; i++) {
      if (list[i].id === currentId) { keptCurrent = true; break; }
    }
    if (!keptCurrent) {
      c = findConversation(currentId);
      if (c) {
        list.push({
          id: c.id, title: c.title, createdAt: c.createdAt,
          updatedAt: c.updatedAt, messages: sanitizeForSave(c.messages)
        });
      }
    }

    var guard = 0;
    while (guard < 60) {
      guard++;
      if (storeSet(KEY_CONVS, JSON.stringify(list))) {
        quotaWarned = false;
        return true;
      }
      if (!hasLocalStorage) { return false; }          /* 只能内存存储，正常现象 */
      if (list.length <= 1) {                          /* 已裁到只剩一个还写不下 */
        if (!quotaWarned) {
          quotaWarned = true;
          setStatus("浏览器存储空间不足，聊天记录可能无法长期保存", true);
        }
        return false;
      }
      /* 从最旧的开始丢，但绝不动当前对话 */
      var removed = false;
      for (i = list.length - 1; i >= 0; i--) {
        if (list[i].id !== currentId) {
          list.splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) { return false; }
    }
    return false;
  }

  function persistSettings() {
    var toSave = {
      apiKey: settings.rememberKey ? settings.apiKey : "",
      model: settings.model,
      baseUrl: settings.baseUrl,
      systemPrompt: settings.systemPrompt,
      rememberKey: settings.rememberKey,
      theme: settings.theme,
      settingsOpen: settings.settingsOpen,
      mdEnabled: settings.mdEnabled,
      streaming: settings.streaming
    };
    storeSet(KEY_SETTINGS, JSON.stringify(toSave));
    storeSet(KEY_CURRENT, currentId || "");
  }

  /* ----------------------------- Markdown -------------------------------- */
  /* 自己写的小解析器：正则 + 字符串，不用任何新 API，也不用 innerHTML。
     所有文字都通过 createTextNode 塞进 DOM —— 模型输出里的 <script> 之类
     结构上就不可能变成标签，所以不存在注入问题。
     正则刻意避开 ES2018 语法（lookbehind、命名分组、dotAll），只用了最普通的
     字符类和量词；量词都带上下界，避免病态回溯把老设备卡死。 */

  var MD_INLINE_RE = /(`+)([^\n]*?)\1|!?\[([^\]\n]*)\]\(([^)\s\n]+)(?:\s+"[^"\n]*")?\)|\*\*(\S[^\n]{0,498}?)\*\*|~~(\S[^\n]{0,498}?)~~|\*(\S[^\n]{0,498}?)\*|\n/;

  var MD_BULLET_RE = /^\s*([-*+])\s+(.*)$/;
  var MD_ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
  var MD_FENCE_RE = /^\s*(`{3,}|~{3,})\s*(.*)$/;
  var MD_HEADING_RE = /^(#{1,6})\s+(.*)$/;
  var MD_HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  var MD_QUOTE_RE = /^\s*>/;

  /* 只允许 http/https/mailto；javascript:、data: 之类一律不生成链接 */
  function mdSafeHref(url) {
    var u = trim(String(url || ""));
    if (!u) { return null; }
    if (/[\u0000-\u001f\u007f]/.test(u)) { return null; }
    if (/^https?:\/\/[^\s]+$/i.test(u)) { return u; }
    if (/^mailto:[^\s]+$/i.test(u)) { return u; }
    return null;
  }

  /* 行内解析：返回一串 {type, text, href} 描述，交给 DOM 构造器去建节点 */
  function mdParseInline(text) {
    var out = [];
    var re = new RegExp(MD_INLINE_RE.source, "g");   /* 每次新建：这个函数会被递归调用 */
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }   /* 防零长度死循环 */
      if (m.index > last) { out.push({ type: "text", text: text.substring(last, m.index) }); }
      if (m[1] !== undefined) { out.push({ type: "code", text: m[2] }); }
      else if (m[3] !== undefined) { out.push({ type: "link", text: m[3], href: m[4] }); }
      else if (m[5] !== undefined) { out.push({ type: "strong", text: m[5] }); }
      else if (m[6] !== undefined) { out.push({ type: "del", text: m[6] }); }
      else if (m[7] !== undefined) { out.push({ type: "em", text: m[7] }); }
      else { out.push({ type: "br" }); }
      last = m.index + m[0].length;
    }
    if (last < text.length) { out.push({ type: "text", text: text.substring(last) }); }
    return out;
  }

  function mdAppendInline(container, text) {
    var nodes = mdParseInline(text);
    var i, n, node, href;
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (n.type === "text") {
        container.appendChild(document.createTextNode(n.text));
      } else if (n.type === "br") {
        container.appendChild(document.createElement("br"));
      } else if (n.type === "code") {
        node = document.createElement("code");
        node.appendChild(document.createTextNode(n.text));
        container.appendChild(node);
      } else if (n.type === "strong" || n.type === "em" || n.type === "del") {
        node = document.createElement(n.type);
        mdAppendInline(node, n.text);       /* 允许 **a `b` c** 这种嵌套，层级有限不会递归爆 */
        container.appendChild(node);
      } else if (n.type === "link") {
        href = mdSafeHref(n.href);
        if (href) {
          node = document.createElement("a");
          node.setAttribute("href", href);
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
          mdAppendInline(node, n.text);
        } else {
          /* 不安全的协议：退化成纯文字，连链接结构都不保留 */
          node = document.createTextNode(n.text + " (" + n.href + ")");
        }
        container.appendChild(node);
      }
    }
  }

  /* 块级解析：把整段文字切成 段落 / 标题 / 列表 / 引用 / 代码块 / 分隔线 */
  function mdParseBlocks(text) {
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    var blocks = [];
    var i = 0, line, m, buf, items, closeRe;

    while (i < lines.length) {
      line = lines[i];

      if (trim(line) === "") { i++; continue; }

      m = MD_FENCE_RE.exec(line);
      if (m) {
        closeRe = m[1].charAt(0) === "`" ? /^\s*`{3,}\s*$/ : /^\s*~{3,}\s*$/;
        buf = [];
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) { i++; }        /* 吃掉结束的围栏 */
        blocks.push({ type: "code", lang: trim(m[2]), text: buf.join("\n") });
        continue;
      }

      if (MD_HR_RE.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

      m = MD_HEADING_RE.exec(line);
      if (m) {
        blocks.push({ type: "h", level: m[1].length, text: trim(m[2]) });
        i++;
        continue;
      }

      if (MD_QUOTE_RE.test(line)) {
        buf = [];
        while (i < lines.length && MD_QUOTE_RE.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        blocks.push({ type: "quote", text: buf.join("\n") });
        continue;
      }

      /* 列表：缩进一律当同级（不做嵌套），但"续行"会并进上一条 */
      m = MD_BULLET_RE.exec(line);
      if (m) {
        items = [];
        while (i < lines.length) {
          m = MD_BULLET_RE.exec(lines[i]);
          if (m) { items.push(m[2]); i++; continue; }
          if (items.length && /^\s+\S/.test(lines[i])) {
            items[items.length - 1] += "\n" + trim(lines[i]);
            i++;
            continue;
          }
          break;
        }
        blocks.push({ type: "ul", items: items });
        continue;
      }
      m = MD_ORDERED_RE.exec(line);
      if (m) {
        items = [];
        while (i < lines.length) {
          m = MD_ORDERED_RE.exec(lines[i]);
          if (m) { items.push(m[1]); i++; continue; }
          if (items.length && /^\s+\S/.test(lines[i])) {
            items[items.length - 1] += "\n" + trim(lines[i]);
            i++;
            continue;
          }
          break;
        }
        blocks.push({ type: "ol", items: items });
        continue;
      }

      /* 剩下的是段落：一直吃到空行或下一个块级结构 */
      buf = [];
      while (i < lines.length &&
             trim(lines[i]) !== "" &&
             !MD_FENCE_RE.test(lines[i]) &&
             !MD_QUOTE_RE.test(lines[i]) &&
             !MD_BULLET_RE.test(lines[i]) &&
             !MD_ORDERED_RE.test(lines[i]) &&
             !MD_HEADING_RE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length === 0) { buf.push(lines[i]); i++; }   /* 保险：绝不让循环卡住 */
      blocks.push({ type: "p", text: buf.join("\n") });
    }
    return blocks;
  }

  function mdAppendBlocks(container, text) {
    var blocks = mdParseBlocks(text);
    var i, k, b, node, li, codeEl;
    for (i = 0; i < blocks.length; i++) {
      b = blocks[i];
      if (b.type === "code") {
        node = document.createElement("pre");
        codeEl = document.createElement("code");
        codeEl.appendChild(document.createTextNode(b.text));
        node.appendChild(codeEl);
        container.appendChild(node);
      } else if (b.type === "hr") {
        container.appendChild(document.createElement("hr"));
      } else if (b.type === "h") {
        node = document.createElement("h" + b.level);
        mdAppendInline(node, b.text);
        container.appendChild(node);
      } else if (b.type === "quote") {
        node = document.createElement("blockquote");
        mdAppendInline(node, b.text);
        container.appendChild(node);
      } else if (b.type === "ul" || b.type === "ol") {
        node = document.createElement(b.type);
        for (k = 0; k < b.items.length; k++) {
          li = document.createElement("li");
          mdAppendInline(li, b.items[k]);
          node.appendChild(li);
        }
        container.appendChild(node);
      } else {
        node = document.createElement("p");
        mdAppendInline(node, b.text);
        container.appendChild(node);
      }
    }
  }

  /* ----------------------------- 渲染 ----------------------------------- */

  function renderConvList() {
    var box = $("convList");
    clearNode(box);
    var i, c, item, title, del;
    for (i = 0; i < conversations.length; i++) {
      c = conversations[i];
      item = el("div", "conv-item" + (c.id === currentId ? " active" : ""));
      item.setAttribute("data-id", c.id);

      title = el("span", null, c.title || "新对话");
      item.appendChild(title);

      del = el("span", "conv-del", "×");
      del.setAttribute("title", "删除这个对话");
      del.setAttribute("data-del", c.id);
      item.appendChild(del);

      box.appendChild(item);
    }
  }

  function renderMessages() {
    var box = $("messages");
    var conv = getCurrent();
    clearNode(box);
    $("convTitle").innerHTML = "";
    $("convTitle").appendChild(document.createTextNode(conv.title || "新对话"));

    if (!conv.messages.length) {
      box.appendChild(el("div", "empty", "还没有消息。在下面输入内容，按发送键开始对话。"));
      afterRender();
      return;
    }

    var i, m, wrap, head, body, name;
    for (i = 0; i < conv.messages.length; i++) {
      m = conv.messages[i];
      name = m.role === "user" ? "我" : (m.role === "error" ? "错误" : "AI");
      wrap = el("div", "msg " + m.role + (m.pending ? " pending" : ""));
      head = el("div", "msg-head", name + " · " + formatTime(m.ts));
      wrap.appendChild(head);

      body = el("div", "msg-body");
      var bodyText = (m.content === "" && m.pending) ? "正在思考…" : m.content;
      /* 只给 AI 的回答做排版：用户自己发的按原样显示，免得打几个 * 就变样 */
      var useMd = settings.mdEnabled && m.role === "assistant" && !m.pending && bodyText !== "";
      if (useMd) {
        body.className = "msg-body md";
        mdAppendBlocks(body, bodyText);
      } else {
        body.appendChild(document.createTextNode(bodyText));
      }
      /* 正在流式输出的那条，记住节点，之后只重画它一个 */
      if (m === streamMsg) { streamBody = body; }
      wrap.appendChild(body);

      if (m.reasoning) {
        wrap.appendChild(el("div", "reasoning", "思考过程：\n" + m.reasoning));
      }
      box.appendChild(wrap);
    }
    afterRender();
  }

  /* 每次渲染后统一处理滚动：只有 autoScroll 为真才把视线拉到底部，
     避免用户正在往上翻看历史时被新消息硬拽回去。 */
  function afterRender() {
    if (autoScroll) { scrollToBottom(); }
    autoScroll = false;
    updateToBottom();
  }

  function syncFormFromSettings() {
    $("apiKey").value = settings.apiKey;
    $("rememberKey").checked = settings.rememberKey;
    $("model").value = settings.model;
    $("systemPrompt").value = settings.systemPrompt;
    $("baseUrl").value = settings.baseUrl;
    $("themeSel").value = settings.theme;
    $("mdEnabled").checked = settings.mdEnabled;
    $("streamEnabled").checked = settings.streaming;
  }

  function readFormIntoSettings() {
    settings.apiKey = trim($("apiKey").value);
    settings.rememberKey = !!$("rememberKey").checked;
    settings.model = $("model").value || DEFAULT_SETTINGS.model;
    settings.systemPrompt = $("systemPrompt").value;
    settings.baseUrl = trim($("baseUrl").value) || DEFAULT_SETTINGS.baseUrl;
    var t = $("themeSel").value;
    if (t === "dark" || t === "light" || t === "auto") { settings.theme = t; }
    settings.mdEnabled = !!$("mdEnabled").checked;
    settings.streaming = !!$("streamEnabled").checked;
  }

  function updateStoreNote() {
    var note = $("storeNote");
    note.innerHTML = "";
    if (!hasLocalStorage) {
      note.appendChild(document.createTextNode("当前浏览器禁用了本地存储（如无痕模式），记录仅在本次会话有效。"));
    } else {
      note.appendChild(document.createTextNode("聊天记录保存在本机浏览器中，不会上传到别处。"));
    }
  }

  /* ----------------------------- 动作 ----------------------------------- */

  function selectConversation(id) {
    if (busy) { setStatus("正在等待回答，请先停止或等待完成", true); return; }
    if (!findConversation(id)) { return; }
    currentId = id;
    storeSet(KEY_CURRENT, currentId);
    closeDrawer();
    autoScroll = true;
    renderConvList();
    renderMessages();
    setStatus("");
  }

  function deleteConversation(id) {
    if (busy) { setStatus("正在等待回答，请稍后再删除", true); return; }
    var c = findConversation(id);
    if (!c) { return; }
    var label = c.title || "新对话";
    if (!window.confirm("确定删除对话“" + label + "”吗？此操作不可恢复。")) { return; }

    var idx = -1, i;
    for (i = 0; i < conversations.length; i++) {
      if (conversations[i].id === id) { idx = i; break; }
    }
    if (idx >= 0) { conversations.splice(idx, 1); }

    if (conversations.length === 0) {
      createConversation();
    } else if (currentId === id) {
      currentId = conversations[0].id;
      storeSet(KEY_CURRENT, currentId);
    }
    persistConversations();
    renderConvList();
    closeDrawer();
    autoScroll = true;
    renderMessages();
    setStatus("已删除对话");
  }

  function newConversation() {
    if (busy) { setStatus("正在等待回答，请先停止或等待完成", true); return; }
    var conv = getCurrent();
    /* 如果当前对话本来就是空的，就不必再新建一个空的 */
    if (!conv.messages.length) {
      setStatus("当前已经是一个空对话");
      return;
    }
    createConversation();
    persistConversations();
    renderConvList();
    closeDrawer();
    autoScroll = true;
    renderMessages();
    setStatus("已新建对话");
    /* 手机上不主动聚焦：弹出键盘会把刚关掉抽屉的界面再顶一次，交给用户自己点输入框 */
    if (!isMobile()) { $("input").focus(); }
  }

  function clearCurrentConversation() {
    if (busy) { setStatus("正在等待回答，请先停止或等待完成", true); return; }
    var conv = getCurrent();
    if (!conv.messages.length) { setStatus("当前对话本来就是空的"); return; }
    if (!window.confirm("确定清空当前对话的全部消息吗？")) { return; }
    conv.messages = [];
    conv.title = "新对话";
    conv.updatedAt = nowMs();
    persistConversations();
    renderConvList();
    closeDrawer();
    autoScroll = true;
    renderMessages();
    setStatus("已清空当前对话");
  }

  function addMessage(conv, role, content, reasoning) {
    var msg = {
      role: role,
      content: content || "",
      reasoning: reasoning || "",
      ts: nowMs()
    };
    conv.messages.push(msg);
    conv.updatedAt = msg.ts;

    if (role === "user") {
      var i, userCount = 0;
      for (i = 0; i < conv.messages.length; i++) {
        if (conv.messages[i].role === "user") { userCount++; }
      }
      if (userCount === 1) {
        var t = content.replace(/\s+/g, " ");
        conv.title = t.length > 18 ? t.substring(0, 18) + "…" : t;
      }
    }
    return msg;
  }

  /* 组装发给接口的消息数组 */
  function buildPayload(conv) {
    var out = [];
    var history = [];
    var i, m;

    if (trim(settings.systemPrompt)) {
      out.push({ role: "system", content: settings.systemPrompt });
    }
    for (i = 0; i < conv.messages.length; i++) {
      m = conv.messages[i];
      if (m.role !== "user" && m.role !== "assistant") { continue; }
      if (m.skip || !m.content) { continue; }
      history.push({ role: m.role, content: m.content });
    }
    if (history.length > SEND_HISTORY_LIMIT) {
      history = history.slice(history.length - SEND_HISTORY_LIMIT);
    }
    /* 开头必须是 user，否则模型可能报错 */
    while (history.length && history[0].role !== "user") { history.shift(); }
    return out.concat(history);
  }

  function setBusy(value) {
    busy = !!value;
    var btn = $("send");
    if (busy) {
      btn.className = "btn btn-stop";
      btn.innerHTML = "";
      btn.appendChild(document.createTextNode("停止"));
    } else {
      btn.className = "btn btn-primary";
      btn.innerHTML = "";
      btn.appendChild(document.createTextNode("发送"));
    }
  }

  function describeHttpError(status, bodyText) {
    var data = jsonParse(bodyText);
    if (!data && bodyText) {
      /* 流式输出到一半报错时，body 会是 "data: {...}\n\n{错误JSON}" 这种混合体，
         整段 parse 会失败。退一步，从最后一个换行后的 { 开始再试一次。 */
      var p = bodyText.lastIndexOf("\n{");
      if (p === -1) { p = bodyText.indexOf("{"); }
      if (p !== -1) { data = jsonParse(trim(bodyText.substring(p))); }
    }
    var apiMsg = "";
    if (data && data.error && data.error.message) { apiMsg = String(data.error.message); }
    var base;
    switch (status) {
      case 0:   base = "网络错误或请求被中断（可能是代理、公司网络或浏览器拦截）"; break;
      case 400: base = "请求格式错误（400）"; break;
      case 401: base = "API Key 无效或未授权（401），请检查 Key 是否填写正确"; break;
      case 402: base = "账户余额不足（402），请到 DeepSeek 平台充值"; break;
      case 403: base = "没有访问权限（403）"; break;
      case 404: base = "接口地址不存在（404），请检查“接口地址”设置"; break;
      case 422: base = "请求参数错误（422）"; break;
      case 429: base = "请求过于频繁（429），请稍后再试"; break;
      case 500:
      case 502:
      case 503:
      case 504: base = "DeepSeek 服务器暂时不可用（" + status + "），请稍后再试"; break;
      default:  base = "请求失败（HTTP " + status + "）";
    }
    return apiMsg ? base + "：" + apiMsg : base;
  }

  /* 用 XMLHttpRequest 调用 /chat/completions（不用 fetch）
   *
   * 流式输出只用两样很老的东西：
   *   - req.onprogress（XHR2，Chrome 10 / Safari 7 就有）
   *   - readyState === 3 时读 req.responseText，拿增量
   * 两者任一失效都不会坏：结束后会把整段按非流式再解析一遍（见下面的兜底）。
   * 全程没有任何 fetch / ReadableStream，老浏览器上语法和 API 都是安全的。 */
  function requestChat(messages, handlers) {
    var url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    var req = new XMLHttpRequest();
    var finished = false;
    var streaming = !!settings.streaming;

    var acc = "";             /* 累积的正文 */
    var accReasoning = "";    /* 累积的思考过程 */
    var lineBuf = "";         /* SSE 行缓冲：一块数据可能把一行切断 */
    var lastLen = 0;          /* responseText 已经消费到的位置 */
    var seenDelta = false;    /* 是否真的收到过增量 */
    var sawDone = false;      /* 是否收到过 [DONE] */
    var sseError = "";        /* SSE 里带回来的错误信息 */
    var idleTimer = null;

    activeXhr = req;
    requestAborted = false;

    /* 统一收尾：标记完成、清掉空闲定时器、断开引用。
       停止请求时也必须走这里，否则那个 60 秒的空闲定时器会留着，
       之后触发还会弹一个莫名其妙的"流式响应中断"。 */
    function settle() {
      finished = true;
      stopIdle();
      activeRequestCleanup = null;
      activeXhr = null;
    }
    activeRequestCleanup = settle;

    function fail(text) {
      if (finished) { return; }
      settle();
      handlers.onError(text);
    }
    function done(content, reasoning) {
      if (finished) { return; }
      settle();
      handlers.onDone(content, reasoning);
    }

    /* ---- 空闲超时：流式不能用整体超时，否则长回答会被砍掉 ---- */
    function stopIdle() {
      if (idleTimer) { window.clearTimeout(idleTimer); idleTimer = null; }
    }
    function resetIdle() {
      if (!streaming) { return; }
      stopIdle();
      idleTimer = window.setTimeout(function () {
        if (finished) { return; }
        requestAborted = true;
        try { req.abort(); } catch (e) { /* 忽略 */ }
        fail("流式响应中断：超过 " + (STREAM_IDLE_TIMEOUT / 1000) + " 秒没有新内容");
      }, STREAM_IDLE_TIMEOUT);
    }

    /* ---- SSE 解析 ---- */
    function handleSseLine(line) {
      if (!line || line.charAt(0) === ":") { return; }        /* 空行 / 注释 */
      if (line.indexOf("data:") !== 0) { return; }            /* 忽略 event: / id: 等 */
      var payload = trim(line.substring(5));
      if (!payload) { return; }
      if (payload === "[DONE]") { sawDone = true; return; }
      var obj = jsonParse(payload);
      if (!obj) { return; }
      if (obj.error && obj.error.message) { sseError = String(obj.error.message); return; }
      var choice = obj.choices && obj.choices[0] ? obj.choices[0] : null;
      if (!choice) { return; }
      var d = choice.delta || {};
      var c = typeof d.content === "string" ? d.content : "";
      var r = typeof d.reasoning_content === "string" ? d.reasoning_content : "";
      if (!c && !r) { return; }
      seenDelta = true;
      acc += c;
      accReasoning += r;
      handlers.onDelta(c, r);
    }

    function handleSseChunk(text) {
      lineBuf += text;
      var idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        handleSseLine(lineBuf.substring(0, idx).replace(/\r$/, ""));
        lineBuf = lineBuf.substring(idx + 1);
      }
    }

    /* 把 responseText 里新增的部分喂给解析器 */
    function drain(isFinal) {
      var full;
      try {
        full = req.responseText;
      } catch (e) {
        return;                       /* 个别浏览器 readyState=3 时读会抛，忽略即可 */
      }
      if (typeof full !== "string" || full.length <= lastLen) { return; }
      var chunk = full.substring(lastLen);
      /* 末尾可能是被切断的多字节汉字：先留着，等下一块补齐再消费，
         否则会永久留下一个 U+FFFD 坏字。 */
      if (!isFinal && chunk.charAt(chunk.length - 1) === "\ufffd") {
        chunk = chunk.substring(0, chunk.length - 1);
        if (!chunk) { return; }
      }
      lastLen += chunk.length;
      handleSseChunk(chunk);
    }

    try {
      req.open("POST", url, true);
    } catch (e) {
      fail("接口地址无法访问：" + url);
      return;
    }

    req.setRequestHeader("Content-Type", "application/json");
    req.setRequestHeader("Authorization", "Bearer " + settings.apiKey);
    if (req.timeout !== undefined) {
      /* 流式靠空闲超时兜底，整体超时会误杀长回答 */
      req.timeout = streaming ? 0 : REQUEST_TIMEOUT;
    }

    if (streaming) {
      /* 两条路径都接上：不同浏览器触发哪个不一样，重复 drain 是幂等的 */
      req.onprogress = function () {
        if (finished || requestAborted) { return; }
        drain(false);
        resetIdle();
      };
      resetIdle();
    }

    req.onreadystatechange = function () {
      if (req.readyState === 3) {
        if (finished || requestAborted || !streaming) { return; }
        drain(false);
        resetIdle();
        return;
      }
      if (req.readyState !== 4) { return; }
      if (requestAborted) { return; }          /* 用户主动停止，由 abort 分支处理 */

      if (req.status >= 200 && req.status < 300) {
        if (streaming) {
          drain(true);                          /* 收尾，把扣着的最后一个字符也吃掉 */
          if (seenDelta || sawDone) { done(acc, accReasoning); return; }
          /* 一个增量都没拿到：可能这个浏览器不吐中间数据，或者接口直接回了整段 JSON。
             两种情况都在这里兜住 —— 这就是"流式失败自动降级"。 */
          var d2 = jsonParse(req.responseText);
          var m2 = d2 && d2.choices && d2.choices[0] ? d2.choices[0].message : null;
          if (m2) { done(m2.content || "", m2.reasoning_content || ""); return; }
          if (sseError) { fail("接口返回错误：" + sseError); return; }
          fail("服务器没有返回回答内容");
          return;
        }
        var data = jsonParse(req.responseText);
        if (!data) { fail("无法解析服务器返回的内容"); return; }
        var msg = data.choices && data.choices[0] ? data.choices[0].message : null;
        if (!msg) {
          if (data.error && data.error.message) { fail("接口返回错误：" + data.error.message); }
          else { fail("服务器没有返回回答内容"); }
          return;
        }
        done(msg.content || "", msg.reasoning_content || "");
      } else {
        fail(describeHttpError(req.status, req.responseText));
      }
    };

    req.onerror = function () {
      if (requestAborted) { return; }
      fail("网络错误：无法连接 " + url + "（请检查网络、接口地址，或浏览器是否拦截了跨域请求）");
    };
    req.ontimeout = function () {
      if (requestAborted) { return; }
      fail("请求超时（超过 " + (REQUEST_TIMEOUT / 1000) + " 秒），请重试");
    };

    try {
      req.send(JSON.stringify({
        model: settings.model,
        messages: messages,
        stream: streaming
      }));
    } catch (e2) {
      fail("发送请求失败：" + (e2 && e2.message ? e2.message : "未知错误"));
    }
  }

  function stopRequest() {
    if (!busy) { return; }
    requestAborted = true;
    if (activeXhr) {
      try { activeXhr.abort(); } catch (e) { /* 忽略 */ }
    }
    if (activeRequestCleanup) { activeRequestCleanup(); }   /* 清掉空闲定时器，避免之后误报 */
    activeXhr = null;
    finishWithError("（已停止）");
    setStatus("已停止本次回答");
  }

  /* 把“正在思考”的占位气泡收尾成 已生成的部分 / 错误 / 已停止 */
  function finishWithError(text) {
    autoScroll = isNearBottom();
    clearStreamTimers();
    streamMsg = null;
    streamBody = null;
    streamReasoningEl = null;

    var conv = getCurrent();
    var i, m;
    for (i = conv.messages.length - 1; i >= 0; i--) {
      m = conv.messages[i];
      if (m.pending) {
        m.pending = false;
        if (text === "（已停止）") {
          /* 停下来的：已经生成的部分留着（那是用户已经看到的内容） */
          m.role = "assistant";
          m.content = m.content ? (m.content + "\n\n（已停止）") : text;
          m.skip = true;          /* 半截内容不再作为后续上下文 */
        } else if (m.content) {
          /* 流到一半出错：已生成的部分也留着，错误附在后面 */
          m.role = "assistant";
          m.content = m.content + "\n\n" + text;
          m.skip = true;
        } else {
          m.role = "error";
          m.content = text;
        }
        break;
      }
    }
    setBusy(false);
    persistConversations();
    renderMessages();
    renderConvList();
  }

  function send() {
    if (busy) { stopRequest(); return; }

    var input = $("input");
    var text = input.value;
    if (!trim(text)) { return; }

    /* 顺手同步表单里未保存的改动，避免“填了 Key 却忘了点保存”被挡住 */
    readFormIntoSettings();

    if (!settings.apiKey) {
      setStatus("请先填写 DeepSeek API Key", true);
      settingsOpenSession = true;        /* 临时展开设置（不落盘），否则用户找不到填 Key 的地方 */
      renderSettingsOpen();
      if (isMobile()) { openDrawer(); scrollSidebarToSettings(); }
      $("apiKey").focus();
      return;
    }
    persistSettings();

    var conv = getCurrent();
    addMessage(conv, "user", text, "");
    input.value = "";
    addMessage(conv, "assistant", "", "");
    var target = conv.messages[conv.messages.length - 1];
    target.pending = true;
    streamMsg = target;                   /* 流式期间直接改这一个气泡，不整屏重画 */

    autoScroll = true;                    /* 自己发的消息，一定跟到底部 */
    renderMessages();
    renderConvList();
    persistConversations();
    setBusy(true);
    setStatus(settings.streaming ? "正在生成…" : "正在等待回答…");

    var payload = buildPayload(conv);
    /* 去掉刚刚插入的空占位（buildPayload 已自动忽略空内容，这里再保险一次） */
    var last = payload.length ? payload[payload.length - 1] : null;
    if (last && last.role === "assistant" && !last.content) { payload.pop(); }

    var gotFirstDelta = false;

    requestChat(payload, {
      /* 每来一小段就更新一次气泡（内部节流，不会每字都重画） */
      onDelta: function (contentDelta, reasoningDelta) {
        if (!gotFirstDelta) {
          gotFirstDelta = true;
          setStatus("");                  /* 文字开始长出来了，就不用再提示"正在生成" */
        }
        if (contentDelta) { target.content += contentDelta; }
        if (reasoningDelta) { target.reasoning += reasoningDelta; }
        scheduleStreamRender();
      },

      onDone: function (content, reasoning) {
        autoScroll = isNearBottom();
        clearStreamTimers();
        streamMsg = null;
        streamBody = null;
        streamReasoningEl = null;

        if (target.pending) {
          target.pending = false;
          target.content = content || target.content || "（模型返回了空内容）";
          target.reasoning = reasoning || target.reasoning || "";
          target.ts = nowMs();
        }
        setBusy(false);
        persistConversations();
        renderMessages();
        renderConvList();
        setStatus("");
      },

      onError: function (errText) {
        clearStreamTimers();
        finishWithError(errText);
        setStatus(errText, true);
      }
    });
  }

  /* --------- 流式输出时的局部刷新（只重画正在生成的那一个气泡）--------- */

  var streamMsg = null;          /* 正在流式输出的那条消息对象 */
  var streamBody = null;         /* 它的 .msg-body 节点 */
  var streamReasoningEl = null;  /* 它的思考过程节点（可能没有） */
  var streamTimer = null;

  function clearStreamTimers() {
    if (streamTimer) { window.clearTimeout(streamTimer); streamTimer = null; }
  }

  /* 节流：一秒钟最多重画几次，老设备也不吃力 */
  function scheduleStreamRender() {
    if (streamTimer) { return; }
    streamTimer = window.setTimeout(function () {
      streamTimer = null;
      renderStreamTick();
    }, STREAM_RENDER_INTERVAL);
  }

  function renderStreamTick() {
    if (!streamMsg || !streamBody) { return; }
    var stick = isNearBottom();      /* 改内容前先看用户在不在底部 */
    var text = streamMsg.content;

    /* 重画这一个气泡：清空子节点再填 */
    while (streamBody.firstChild) { streamBody.removeChild(streamBody.firstChild); }
    if (settings.mdEnabled && text) {
      streamBody.className = "msg-body md";
      mdAppendBlocks(streamBody, text);
    } else {
      streamBody.className = "msg-body";
      streamBody.appendChild(document.createTextNode(text));
    }

    /* 思考过程（deepseek-reasoner）边走边显示 */
    if (streamMsg.reasoning) {
      if (!streamReasoningEl || !streamReasoningEl.parentNode) {
        streamReasoningEl = el("div", "reasoning");
        if (streamBody.parentNode) { streamBody.parentNode.appendChild(streamReasoningEl); }
      }
      while (streamReasoningEl.firstChild) { streamReasoningEl.removeChild(streamReasoningEl.firstChild); }
      streamReasoningEl.appendChild(document.createTextNode("思考过程：\n" + streamMsg.reasoning));
    }

    if (stick) { scrollToBottom(); }
    updateToBottom();
  }

  /* 手机键盘没有 Shift+Enter，用它插入换行 */
  function insertNewline() {
    var ta = $("input");
    var start = null, end = null;
    try {
      start = ta.selectionStart;
      end = ta.selectionEnd;
    } catch (e) { /* 老浏览器取不到光标位置 */ }

    if (typeof start !== "number" || typeof end !== "number") {
      ta.value = ta.value + "\n";
    } else {
      ta.value = ta.value.substring(0, start) + "\n" + ta.value.substring(end);
      try { ta.selectionStart = ta.selectionEnd = start + 1; } catch (e2) { /* 忽略 */ }
    }
    ta.focus();
  }

  /* ----------------------------- 事件绑定 ------------------------------- */

  function bindEvents() {
    $("send").onclick = send;
    $("menuBtn").onclick = toggleDrawer;
    $("overlay").onclick = closeDrawer;
    $("newlineBtn").onclick = insertNewline;
    $("settingsHead").onclick = toggleSettings;

    /* 深色 / 浅色：顶栏一键切换（浅↔深），侧栏可选「跟随系统」 */
    $("themeBtn").onclick = function () {
      var dark = themeIsDark(settings.theme);
      setTheme(dark ? "light" : "dark");
      setStatus(dark ? "已切换到浅色" : "已切换到深色");
    };
    $("themeSel").onchange = function () {
      setTheme($("themeSel").value);
      setStatus("外观已保存");
    };
    /* Markdown 开关：立刻重画，方便对比效果 */
    $("mdEnabled").onchange = function () {
      settings.mdEnabled = !!$("mdEnabled").checked;
      persistSettings();
      autoScroll = isNearBottom();
      renderMessages();
    };
    /* 流式开关：下次发送生效（不影响正在进行的回答） */
    $("streamEnabled").onchange = function () {
      settings.streaming = !!$("streamEnabled").checked;
      persistSettings();
    };
    bindSystemTheme();

    $("toBottom").onclick = function () {
      autoScroll = true;
      scrollToBottom();
      updateToBottom();
    };

    /* 页面滚动（移动端）时决定「回到底部」按钮显示与否 */
    window.onscroll = updateToBottom;
    window.onresize = function () {
      closeDrawer();
      syncHeaderSpace();
      updateToBottom();
    };
    if ("onorientationchange" in window) {
      window.onorientationchange = function () {
        closeDrawer();
        /* 旋转后尺寸变化有延迟，等一帧再量 */
        window.setTimeout(function () { syncHeaderSpace(); updateToBottom(); }, 350);
      };
    }

    $("input").onkeydown = function (e) {
      e = e || window.event;
      var code = e.keyCode || e.which;
      /* 中文输入法组合期间不发送 */
      if (e.isComposing === true || code === 229) { return; }
      if (code === 13 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.preventDefault) { e.preventDefault(); }
        send();
      }
    };

    $("newChat").onclick = newConversation;
    $("clearChat").onclick = clearCurrentConversation;

    $("saveSettings").onclick = function () {
      readFormIntoSettings();
      persistSettings();
      renderSettingsHint();     /* 填好 Key 后把「需要填写 API Key」的提示去掉，但不强制收起 */
      if (settings.rememberKey) {
        setStatus(settings.apiKey ? "设置已保存（Key 存在本机浏览器中）" : "设置已保存，但 API Key 还是空的");
      } else {
        setStatus("设置已保存，Key 仅本次会话有效");
      }
      if (!hasLocalStorage) {
        setStatus("设置已保存（浏览器禁用本地存储，刷新后会丢失）", true);
      }
    };

    /* 历史对话列表用事件委托（老浏览器同样支持） */
    $("convList").onclick = function (e) {
      e = e || window.event;
      var target = e.target || e.srcElement;
      if (!target) { return; }
      var delId = target.getAttribute ? target.getAttribute("data-del") : null;
      if (delId) {
        if (e.stopPropagation) { e.stopPropagation(); }
        deleteConversation(delId);
        return;
      }
      var node = target;
      while (node && node !== this) {
        if (node.getAttribute && node.getAttribute("data-id")) {
          selectConversation(node.getAttribute("data-id"));
          return;
        }
        node = node.parentNode;
      }
    };

    /* 关掉页面前尽量保存一次 */
    window.onbeforeunload = function () {
      persistConversations();
      persistSettings();
    };
  }

  /* ----------------------------- 启动 ----------------------------------- */

  function init() {
    loadState();
    applyTheme();                   /* head 里的内联脚本已先定过一次，这里按最新设置再确认 */
    bindEvents();
    syncFormFromSettings();
    settingsOpenSession = null;
    renderSettingsOpen();
    updateStoreNote();
    autoScroll = true;              /* 打开就停在最新消息处，手机上不用先往上翻 */
    renderConvList();
    renderMessages();
    syncHeaderSpace();
    updateToBottom();
    closeDrawer();

    if (!settings.apiKey) {
      setStatus("请先在左侧填写 DeepSeek API Key（手机点左上角「菜单」）");
    } else if (!hasLocalStorage) {
      setStatus("浏览器禁用了本地存储，记录仅本次会话有效", true);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, false);
  } else {
    init();
  }
})();
