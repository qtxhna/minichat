/* 临时冒烟测试：用最小 DOM / localStorage / XHR 桩件跑 app.js，验证核心流程。
   仅用于本次验证，验证后会删除。 */
"use strict";

/* ---------------- 极简 DOM 桩件 ---------------- */
function makeEl(tag) {
  var node = {
    tagName: tag,
    childNodes: [],
    attrs: {},
    style: {},
    className: "",
    value: "",
    checked: false,
    scrollTop: 0,
    scrollHeight: 500,
    offsetHeight: 40,
    clientHeight: 400,
    selectionStart: 0,
    selectionEnd: 0,
    parentNode: null,
    _html: "",
    appendChild: function (c) { c.parentNode = node; node.childNodes.push(c); return c; },
    removeChild: function (c) {
      for (var i = 0; i < node.childNodes.length; i++) {
        if (node.childNodes[i] === c) { node.childNodes.splice(i, 1); break; }
      }
      return c;
    },
    setAttribute: function (k, v) { node.attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null; },
    focus: function () {},
    onclick: null,
    onkeydown: null
  };
  Object.defineProperty(node, "firstChild", { get: function () { return node.childNodes[0] || null; } });
  Object.defineProperty(node, "innerHTML", {
    get: function () { return node._html; },
    set: function (v) { node._html = String(v); if (v === "") { node.childNodes = []; } }
  });
  return node;
}

var byId = {};
["apiKey", "rememberKey", "saveSettings", "model", "systemPrompt", "baseUrl",
 "newChat", "clearChat", "convList", "storeNote", "convTitle", "status",
 "messages", "input", "hint", "send", "menuBtn", "overlay", "toBottom",
 "newlineBtn", "sidebar", "topbar", "themeBtn", "themeSel",
 "settingsHead", "settingsCaret", "settingsHint", "settingsBody", "settingsBlock",
 "mdEnabled"].forEach(function (id) { byId[id] = makeEl("div"); });

var metaTheme = makeEl("meta");
metaTheme.setAttribute("name", "theme-color");
metaTheme.setAttribute("content", "#f2f4f7");

var htmlEl = makeEl("html");
var bodyEl = makeEl("body");
htmlEl.scrollHeight = 1200;
bodyEl.scrollHeight = 1200;

var document = {
  readyState: "complete",
  documentElement: htmlEl,
  body: bodyEl,
  getElementById: function (id) { return byId[id] || null; },
  getElementsByTagName: function (tag) { return tag === "meta" ? [metaTheme] : []; },
  createElement: function (tag) { return makeEl(tag); },
  createTextNode: function (t) { return { nodeType: 3, textContent: String(t), parentNode: null }; },
  addEventListener: function () {}
};

/* ---------------- localStorage 桩件 ---------------- */
var lsData = {};
var lsQuota = 5 * 1024 * 1024;
var localStorage = {
  setItem: function (k, v) {
    v = String(v);
    if (v.length > lsQuota) { var e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
    lsData[k] = v;
  },
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(lsData, k) ? lsData[k] : null; },
  removeItem: function (k) { delete lsData[k]; }
};

/* ---------------- XHR 桩件 ---------------- */
var lastXhr = null;
function XHR() {
  this.readyState = 0; this.status = 0; this.responseText = ""; this.timeout = 0;
  this.headers = {}; this.body = null; this.method = null; this.url = null;
  this.onreadystatechange = null; this.onerror = null; this.ontimeout = null;
  lastXhr = this;
}
XHR.prototype.open = function (m, u, a) { this.method = m; this.url = u; this.async = a; this.readyState = 1; };
XHR.prototype.setRequestHeader = function (k, v) { this.headers[k] = v; };
XHR.prototype.send = function (b) { this.body = b; };
XHR.prototype.abort = function () { this.aborted = true; };
XHR.prototype.respond = function (status, text) {
  this.status = status; this.responseText = text; this.readyState = 4;
  if (this.onreadystatechange) { this.onreadystatechange(); }
};

global.document = document;
global.XMLHttpRequest = XHR;
var scrollCalls = [];
global.window = {
  localStorage: localStorage,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  confirm: function () { return true; },
  onbeforeunload: null,
  onorientationchange: null,
  innerWidth: 1200,
  innerHeight: 600,
  pageYOffset: 0,
  scrollTo: function (x, y) {
    scrollCalls.push(y);
    /* 像真实浏览器一样：滚动后 pageYOffset 变化，并且被夹在可滚动范围内 */
    var maxY = document.documentElement.scrollHeight - window.innerHeight;
    if (maxY < 0) { maxY = 0; }
    window.pageYOffset = y > maxY ? maxY : y;
  },
  addEventListener: function () {}
};
global.localStorage = localStorage;

/* ---------------- 运行 app.js ---------------- */
var path = require("path");
var fs = require("fs");
var appPath = path.join(__dirname, "..", "app.js");
function loadApp() { delete require.cache[require.resolve(appPath)]; require(appPath); }

var failures = [];
function check(name, cond, extra) {
  if (cond) { console.log("  PASS  " + name); }
  else { console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); failures.push(name); }
}

/* 把 DOM 子树压成一行字符串，方便断言结构 */
function repr(node) {
  if (!node) { return "<null>"; }
  if (node.nodeType === 3) { return node.textContent; }
  var s = node.tagName;
  if (node.className) { s += "." + node.className; }
  if (node.attrs && node.attrs.href) { s += "[" + node.attrs.href + "]"; }
  var kids = [], i;
  for (i = 0; i < node.childNodes.length; i++) { kids.push(repr(node.childNodes[i])); }
  return kids.length ? s + "(" + kids.join(",") + ")" : s;
}

/* 走真实链路：发一条消息 → 用假回答填充 → 取出这条回答的 .msg-body */
function renderAssistant(mdText) {
  byId.input.value = "让我看看";
  byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
  lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: mdText } }] }));
  var msgs = byId.messages.childNodes;
  return msgs[msgs.length - 1].childNodes[1];
}

/* 子树里是否真的存在某个标签（注意：不能拿结构串去 indexOf("img")，
   因为纯文字里也可能出现 img 这几个字母） */
function hasTag(node, tag) {
  if (!node || node.nodeType === 3) { return false; }
  if (node.tagName && String(node.tagName).toLowerCase() === tag) { return true; }
  var i;
  for (i = 0; i < node.childNodes.length; i++) {
    if (hasTag(node.childNodes[i], tag)) { return true; }
  }
  return false;
}

/* 递归取出全部文字，不关心排版结构 */
function textOf(node) {
  if (!node) { return ""; }
  if (node.nodeType === 3) { return node.textContent; }
  var s = "", i;
  for (i = 0; i < node.childNodes.length; i++) { s += textOf(node.childNodes[i]); }
  return s;
}

/* 只要子节点的结构串 */
function kidsRepr(node) {
  var kids = [], i;
  for (i = 0; i < node.childNodes.length; i++) { kids.push(repr(node.childNodes[i])); }
  return kids.join("|");
}

/* 渲染一条 AI 回答，返回其内部结构串 */
function mdRepr(mdText) { return kidsRepr(renderAssistant(mdText)); }

console.log("\n[1] 首次加载（空存储）");
loadApp();
check("自动创建了一个空对话", byId.convList.childNodes.length === 1);
check("显示了空态提示", byId.messages.childNodes.length === 1);
check("提示需要填写 Key", /API Key/.test(byId.status.childNodes.map(function (n) { return n.textContent; }).join("")));

console.log("\n[2] 保存设置");
byId.apiKey.value = "  sk-test-123  ";
byId.rememberKey.checked = true;
byId.model.value = "deepseek-reasoner";
byId.systemPrompt.value = "你是简洁的助手";
byId.baseUrl.value = "https://api.deepseek.com/";
byId.saveSettings.onclick();
var saved = JSON.parse(lsData["minichat.settings.v1"]);
check("Key 被 trim 后保存", saved.apiKey === "sk-test-123", saved.apiKey);
check("模型已保存", saved.model === "deepseek-reasoner");
check("系统提示词已保存", saved.systemPrompt === "你是简洁的助手");

console.log("\n[3] 发送消息（Enter 键）→ 请求内容");
byId.input.value = "你好，介绍一下你自己";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
check("已发起 XHR", !!lastXhr);
check("URL 去掉了末尾斜杠", lastXhr.url === "https://api.deepseek.com/chat/completions", lastXhr.url);
check("使用 POST", lastXhr.method === "POST");
check("带 Authorization 头", lastXhr.headers["Authorization"] === "Bearer sk-test-123", lastXhr.headers["Authorization"]);
var sent = JSON.parse(lastXhr.body);
check("stream=false", sent.stream === false);
check("model 正确", sent.model === "deepseek-reasoner");
check("首条为 system", sent.messages[0].role === "system" && sent.messages[0].content === "你是简洁的助手");
check("末条为 user", sent.messages[sent.messages.length - 1].role === "user");
check("未把空占位发给接口", sent.messages.length === 2, JSON.stringify(sent.messages));
check("发送中按钮变停止", byId.send.childNodes[0].textContent === "停止");
check("对话标题取自首条消息", byId.convTitle.childNodes[0].textContent.indexOf("你好") === 0);

console.log("\n[4] 收到回答");
lastXhr.respond(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "你好！我是 DeepSeek。", reasoning_content: "先打招呼" } }] }));
check("回答已渲染", byId.messages.childNodes.length === 2);
var lastMsg = byId.messages.childNodes[1];
check("回答文本正确", textOf(lastMsg.childNodes[1]) === "你好！我是 DeepSeek。", textOf(lastMsg.childNodes[1]));
check("思考过程单独显示", lastMsg.childNodes.length === 3);
check("按钮恢复为发送", byId.send.childNodes[0].textContent === "发送");
check("消息已落盘", /DeepSeek/.test(lsData["minichat.conversations.v1"]));

console.log("\n[5] 错误处理（401）");
byId.input.value = "再来一次";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
lastXhr.respond(401, JSON.stringify({ error: { message: "Authentication Fails" } }));
var lastMsg2 = byId.messages.childNodes[byId.messages.childNodes.length - 1];
check("错误气泡出现", lastMsg2.className.indexOf("error") !== -1, lastMsg2.className);
check("错误文案含 401 与原始信息",
  /401/.test(lastMsg2.childNodes[1].childNodes[0].textContent) &&
  /Authentication Fails/.test(lastMsg2.childNodes[1].childNodes[0].textContent));

/* 错误之后继续发，确认错误提示没有被当成上下文发回给接口 */
byId.input.value = "错误之后继续";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
var afterErr = JSON.parse(lastXhr.body);
check("错误提示没有进入上下文", JSON.stringify(afterErr.messages).indexOf("Authentication Fails") === -1);
var rolesOk = true, ri;
for (ri = 0; ri < afterErr.messages.length; ri++) {
  var r = afterErr.messages[ri].role;
  if (r !== "user" && r !== "assistant" && r !== "system") { rolesOk = false; }
}
check("上下文里只有 user/assistant/system", rolesOk);
lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: "好的" } }] }));

console.log("\n[6] 新对话 / 切换 / 清空 / 删除");
byId.newChat.onclick();
check("新建后有 2 个对话", byId.convList.childNodes.length === 2);
check("新对话是空的", byId.messages.childNodes.length === 1);
byId.input.value = "第二个对话的消息";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: "收到" } }] }));
check("第二条对话有 2 条消息", byId.messages.childNodes.length === 2);

/* 切换到第一个对话（列表第 2 项，点标题而不是删除按钮） */
var secondItem = byId.convList.childNodes[1];
byId.convList.onclick({ target: secondItem.childNodes[0], srcElement: secondItem.childNodes[0] });
check("切换后显示旧对话的 6 条消息", byId.messages.childNodes.length === 6, byId.messages.childNodes.length);
check("切换后高亮跟随", byId.convList.childNodes[1].className.indexOf("active") !== -1);

/* 删除当前对话，应自动切到剩下的那个 */
byId.convList.onclick({ target: byId.convList.childNodes[1].childNodes[1], srcElement: byId.convList.childNodes[1].childNodes[1] });
check("删除当前对话后只剩 1 个", byId.convList.childNodes.length === 1);
check("自动切到剩下的对话（2 条消息）", byId.messages.childNodes.length === 2, byId.messages.childNodes.length);
check("已删除的对话不再落盘",
  JSON.parse(lsData["minichat.conversations.v1"]).length === 1 &&
  lsData["minichat.conversations.v1"].indexOf("第二个对话的消息") !== -1);

/* 清空当前对话 */
byId.clearChat.onclick();
check("清空后只剩空态", byId.messages.childNodes.length === 1);
check("清空后标题重置", byId.convTitle.childNodes[0].textContent === "新对话");

console.log("\n[7] 模拟刷新页面（重新加载 app.js，沿用同一存储）");
var beforeConvs = byId.convList.childNodes.length;
loadApp();
check("设置被恢复", byId.apiKey.value === "sk-test-123", byId.apiKey.value);
check("模型被恢复", byId.model.value === "deepseek-reasoner");
check("历史对话被恢复", byId.convList.childNodes.length === beforeConvs);

console.log("\n[8] 存储被禁用（无痕模式）时退化为内存");
global.window.localStorage = { setItem: function () { throw new Error("denied"); }, getItem: function () { throw new Error("denied"); }, removeItem: function () {} };
lsData = {};
loadApp();
check("不抛异常，仍可用", byId.convList.childNodes.length === 1);
check("给出无痕模式提示", /本地存储/.test(byId.storeNote.childNodes.map(function (n) { return n.textContent; }).join("")));
byId.apiKey.value = "sk-mem";
byId.saveSettings.onclick();
byId.input.value = "内存模式测试";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
check("内存模式下仍能完成一轮对话", byId.messages.childNodes.length === 2);

console.log("\n[9] 输入法组合期间不误发送");
var xhrBefore = lastXhr;
byId.input.value = "组合中";
byId.input.onkeydown({ keyCode: 229, shiftKey: false, preventDefault: function () {} });
check("keyCode 229 不发送", lastXhr === xhrBefore);
byId.input.onkeydown({ keyCode: 13, shiftKey: true, preventDefault: function () {} });
check("Shift+Enter 不发送", lastXhr === xhrBefore);

console.log("\n[10] 存储配额不足时自动裁剪");
lsData = {};
global.window.localStorage = localStorage;
loadApp();
byId.apiKey.value = "sk-q"; byId.saveSettings.onclick();
lsQuota = 1200; /* 逼出配额错误 */
var i;
for (i = 0; i < 12; i++) { byId.newChat.onclick(); byId.input.value = "填充消息 " + i + " " + new Array(30).join("x"); byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} }); lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: "回复" } }] })); }
check("配额受限时未崩溃，仍能保存", !!lsData["minichat.conversations.v1"]);
check("存储体积被控制在配额内", (lsData["minichat.conversations.v1"] || "").length <= lsQuota);

console.log("\n[11] 填了 Key 但忘记点“保存设置”，直接发送也应可用");
lsData = {};
lsQuota = 5 * 1024 * 1024;
global.window.localStorage = localStorage;
loadApp();
byId.apiKey.value = "sk-typed-but-not-saved";
byId.model.value = "deepseek-chat";
byId.input.value = "没点保存就发送";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
check("仍然发出了请求", !!lastXhr && lastXhr.headers["Authorization"] === "Bearer sk-typed-but-not-saved",
  lastXhr ? lastXhr.headers["Authorization"] : "no xhr");
check("未保存的模型选择也生效", JSON.parse(lastXhr.body).model === "deepseek-chat");
lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: "好的" } }] }));
check("对话正常完成", byId.messages.childNodes.length === 2);

console.log("\n[12] 移动端交互");
lsData = {};
lsQuota = 5 * 1024 * 1024;
global.window.localStorage = localStorage;
window.matchMedia = function () { return { matches: true }; };
window.innerWidth = 380;
window.innerHeight = 600;
window.pageYOffset = 0;
document.documentElement.scrollHeight = 1200;
document.body.scrollHeight = 1200;
scrollCalls = [];
loadApp();

check("顶栏占位按顶栏实际高度计算", byId.messages.style.paddingTop === "48px", byId.messages.style.paddingTop);
check("抽屉默认收起", byId.sidebar.className === "" && byId.overlay.className === "");

byId.menuBtn.onclick();
check("点「菜单」打开抽屉", byId.sidebar.className === "open" && byId.overlay.className === "open");
byId.overlay.onclick();
check("点遮罩关闭抽屉", byId.sidebar.className === "" && byId.overlay.className === "");

byId.input.value = "没填 key 就发";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
check("没填 Key 时自动打开设置抽屉", byId.sidebar.className === "open" && byId.overlay.className === "open");

byId.apiKey.value = "sk-mobile";
byId.saveSettings.onclick();
byId.input.value = "手机端消息";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
check("手机端能正常发送", !!lastXhr && /手机端消息/.test(lastXhr.body));
scrollCalls = [];
lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: "手机端回答" } }] }));
check("人在底部时，回答会自动滚出来", scrollCalls.length > 0, String(scrollCalls));

/* 用户翻上去看历史时，新回答不能把他硬拽回底部 */
byId.input.value = "第二条";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
window.pageYOffset = 0;                    /* 模拟用户往上翻 */
scrollCalls = [];
lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: "第二条回答" } }] }));
check("翻看历史时不被拽回底部", scrollCalls.length === 0, String(scrollCalls));

byId.menuBtn.onclick();
byId.newChat.onclick();
check("新建对话后抽屉自动关闭", byId.sidebar.className === "");
check("新建对话后显示空态", byId.messages.childNodes.length === 1);

byId.input.value = "第一行";
byId.input.selectionStart = 2;
byId.input.selectionEnd = 2;
byId.newlineBtn.onclick();
check("换行按钮在光标处插入换行", byId.input.value === "第一\n行", JSON.stringify(byId.input.value));
check("换行后光标落到下一行开头", byId.input.selectionStart === 3, byId.input.selectionStart);

window.pageYOffset = 0;                 /* 距底部 600px，较远 */
byId.toBottom.style.display = "";
window.onscroll();
check("离底部较远时显示「回到底部」", byId.toBottom.style.display === "block", byId.toBottom.style.display);
window.pageYOffset = 1150;              /* 已接近底部 */
window.onscroll();
check("接近底部时隐藏「回到底部」", byId.toBottom.style.display === "none", byId.toBottom.style.display);

/* 横竖屏切换 / 窗口尺寸变化 */
window.matchMedia = function () { return { matches: false }; };
window.onresize();
check("切回桌面时清掉内联顶栏占位", byId.messages.style.paddingTop === "", byId.messages.style.paddingTop);
check("桌面端隐藏「回到底部」", byId.toBottom.style.display === "none");
window.matchMedia = function () { return { matches: true }; };
window.onresize();
check("切回移动端时重新计算占位", byId.messages.style.paddingTop === "48px", byId.messages.style.paddingTop);

console.log("\n[13] 深色模式");
lsData = {};
global.window.localStorage = localStorage;
window.matchMedia = function (q) {
  /* 系统是深色 */
  return { matches: q.indexOf("prefers-color-scheme: dark") !== -1, media: q, addListener: function () {}, addEventListener: function () {} };
};
loadApp();
check("跟随系统：系统深色则页面深色", document.documentElement.className === "dark", document.documentElement.className);
check("深色时顶栏按钮显示 ☀", byId.themeBtn.childNodes[0].textContent === "☀", byId.themeBtn.childNodes[0].textContent);
check("状态栏用 class 而不是内联颜色", !byId.status.style.color, String(byId.status.style.color));
check("状态栏带上了 .err/.ok", byId.status.className.indexOf("status") === 0 && /err|ok/.test(byId.status.className), byId.status.className);
check("手机状态栏颜色跟着变深", metaTheme.attrs.content === "#1e2126", metaTheme.attrs.content);

byId.themeBtn.onclick();
check("一键切成浅色", document.documentElement.className === "light", document.documentElement.className);
check("浅色已落盘", JSON.parse(lsData["minichat.settings.v1"]).theme === "light");
check("浅色时按钮显示 ☾", byId.themeBtn.childNodes[0].textContent === "☾");
check("状态栏颜色跟着变浅", metaTheme.attrs.content === "#f2f4f7", metaTheme.attrs.content);

byId.themeBtn.onclick();
check("再点一下切回深色", document.documentElement.className === "dark" && JSON.parse(lsData["minichat.settings.v1"]).theme === "dark");

/* 侧栏「跟随系统」：系统换成浅色后应跟着变 */
byId.themeSel.value = "auto";
byId.themeSel.onchange();
check("选「跟随系统」后按系统（当前深色）", document.documentElement.className === "dark", document.documentElement.className);
window.matchMedia = function (q) { return { matches: false, media: q, addListener: function () {}, addEventListener: function () {} }; };
byId.themeSel.value = "auto";
byId.themeSel.onchange();
check("系统切浅色后跟着变浅", document.documentElement.className === "light", document.documentElement.className);

/* 用户明确选了浅色，系统即使是深色也不该被覆盖 */
window.matchMedia = function (q) { return { matches: true, media: q, addListener: function () {}, addEventListener: function () {} }; };
byId.themeSel.value = "light";
byId.themeSel.onchange();
loadApp();
check("刷新后仍尊重用户选的浅色", document.documentElement.className === "light", document.documentElement.className);

/* 存储里出现非法值时退回跟随系统，而不是坏掉 */
lsData["minichat.settings.v1"] = JSON.stringify({ theme: "purple" });
loadApp();
check("非法主题值退回跟随系统", document.documentElement.className === "dark", document.documentElement.className);

/* 老浏览器没有 matchMedia：不能报错，「跟随系统」当浅色 */
delete window.matchMedia;
lsData = {};
loadApp();
check("没有 matchMedia 时当浅色处理", document.documentElement.className === "light", document.documentElement.className);
byId.themeBtn.onclick();
check("没有 matchMedia 也能手动切深色", document.documentElement.className === "dark", document.documentElement.className);

console.log("\n[14] 历史对话置顶 + 设置折叠");
lsData = {};
global.window.localStorage = localStorage;
window.matchMedia = function (q) { return { matches: false, media: q, addListener: function () {}, addEventListener: function () {} }; };
loadApp();
check("没填 Key 时设置默认展开", byId.settingsBody.style.display === "block", byId.settingsBody.style.display);
check("展开时箭头朝下 ▾", byId.settingsCaret.childNodes[0].textContent === "▾", byId.settingsCaret.childNodes[0].textContent);
check("并提示需要填写 Key",
  /API Key/.test(byId.settingsHint.childNodes.map(function (n) { return n.textContent; }).join("")));

byId.settingsHead.onclick();
check("点标题可收起", byId.settingsBody.style.display === "none", byId.settingsBody.style.display);
check("收起时箭头朝右 ▸", byId.settingsCaret.childNodes[0].textContent === "▸");
check("用户的手动选择已落盘", JSON.parse(lsData["minichat.settings.v1"]).settingsOpen === false);

loadApp();
check("刷新后仍是用户选的收起状态", byId.settingsBody.style.display === "none", byId.settingsBody.style.display);
byId.settingsHead.onclick();
check("再点可以重新展开", byId.settingsBody.style.display === "block");

byId.apiKey.value = "sk-abc";
byId.saveSettings.onclick();
check("填好 Key 后警告消失", byId.settingsHint.childNodes.length === 0);
check("保存设置不会强行收起", byId.settingsBody.style.display === "block", byId.settingsBody.style.display);

/* 清掉手动选择：填过 Key 就应当默认收起 */
lsData["minichat.settings.v1"] = JSON.stringify({ apiKey: "sk-abc", settingsOpen: null, theme: "light" });
loadApp();
check("填过 Key 且没手动选过 → 默认收起", byId.settingsBody.style.display === "none", byId.settingsBody.style.display);

/* 用户手动收起后，没填 Key 就发送 → 应当自动展开，否则找不到填 Key 的地方 */
delete lsData["minichat.settings.v1"];
loadApp();
byId.settingsHead.onclick();
check("先手动收起", byId.settingsBody.style.display === "none", byId.settingsBody.style.display);
byId.input.value = "还没填 key";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
check("没填 Key 时发送会强制展开设置", byId.settingsBody.style.display === "block", byId.settingsBody.style.display);
check("并且给出需要填 Key 的提示",
  /API Key/.test(byId.status.childNodes.map(function (n) { return n.textContent; }).join("")));

/* 结构上：历史对话必须排在设置之前 */
var htmlSrc = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
var posList = htmlSrc.indexOf("id=\"convList\"");
var posSettings = htmlSrc.indexOf("id=\"settingsBlock\"");
check("HTML 里历史对话块排在设置块之前", posList > -1 && posSettings > -1 && posList < posSettings,
  posList + " vs " + posSettings);
check("「＋ 新对话 / 清空当前对话」在历史对话块内",
  htmlSrc.indexOf("id=\"newChat\"") > -1 && htmlSrc.indexOf("id=\"newChat\"") < posList);

console.log("\n[15] Markdown 排版");
lsData = {};
lsQuota = 5 * 1024 * 1024;
global.window.localStorage = localStorage;
window.matchMedia = function (q) { return { matches: false, media: q, addListener: function () {}, addEventListener: function () {} }; };
loadApp();
byId.apiKey.value = "sk-md";
byId.saveSettings.onclick();

var mdCases = [
  ["**粗体**", "p(strong(粗体))"],
  ["*斜体*", "p(em(斜体))"],
  ["~~删除~~", "p(del(删除))"],
  ["`x = 1`", "p(code(x = 1))"],
  ["# 一级标题", "h1(一级标题)"],
  ["### 三级标题", "h3(三级标题)"],
  ["- 甲\n- 乙", "ul(li(甲),li(乙))"],
  ["1. 甲\n2. 乙", "ol(li(甲),li(乙))"],
  ["> 引用一句", "blockquote(引用一句)"],
  ["---", "hr"],
  ["第一行\n第二行", "p(第一行,br,第二行)"],
  ["[链接](https://example.com)", "p(a[https://example.com](链接))"],
  ["```js\nvar a = 1;\n```", "pre(code(var a = 1;))"],
  ["代码里有星号 `**不是粗体**`", "p(代码里有星号 ,code(**不是粗体**))"],
  ["变量名 my_var_name 不该被斜体", "p(变量名 my_var_name 不该被斜体)"],
  ["**粗** 和 *斜* 混排", "p(strong(粗), 和 ,em(斜), 混排)"],
  ["列表续行\n- 第一项\n  接着写的内容\n- 第二项", "p(列表续行)|ul(li(第一项,br,接着写的内容),li(第二项))"]
];
var ci, got;
for (ci = 0; ci < mdCases.length; ci++) {
  got = mdRepr(mdCases[ci][0]);
  check("渲染 " + JSON.stringify(mdCases[ci][0]).substring(0, 34), got === mdCases[ci][1], got);
}

/* 安全：模型输出里的标签只能是文字，不能变成元素 */
var body1 = renderAssistant("<script>alert(1)</script>");
check("script 标签不会被创建", !hasTag(body1, "script"), repr(body1));
check("标签内容完整保留为文字", textOf(body1) === "<script>alert(1)</script>", textOf(body1));

var body2 = renderAssistant("<img src=x onerror=alert(1)>");
check("img 标签不会被创建", !hasTag(body2, "img"), repr(body2));
check("onerror 只是文字", textOf(body2).indexOf("onerror=alert(1)") > -1, textOf(body2));

var body3 = renderAssistant("[点我](javascript:alert(1))");
check("javascript: 链接被拒绝（不生成 a 元素）", !hasTag(body3, "a"), repr(body3));
check("但文字仍然能看到", textOf(body3).indexOf("javascript:alert(1)") > -1, textOf(body3));

var body4 = renderAssistant("[点我](data:text/html,<b>x</b>)");
check("data: 链接被拒绝", !hasTag(body4, "a"), repr(body4));

var body5 = renderAssistant("```\n<script>alert(1)</script>\n```");
check("代码块里的标签也是纯文字", !hasTag(body5, "script") && textOf(body5) === "<script>alert(1)</script>", repr(body5));

var body6 = renderAssistant("![图片](https://example.com/a.png)");
check("图片不会被真的加载（只是链接）", !hasTag(body6, "img") && hasTag(body6, "a"), repr(body6));
check("链接带 https 地址", body6.childNodes[0].childNodes[0].attrs.href === "https://example.com/a.png",
  body6.childNodes[0].childNodes[0].attrs.href);

/* 病态输入不能把解析器卡死（量词都带下界） */
var t0 = Date.now();
mdRepr(new Array(2001).join("*") + " 结尾");
var dt = Date.now() - t0;
check("2000 个星号不会卡死（" + dt + "ms）", dt < 2000, dt + "ms");

/* 用户可以关掉排版 */
byId.mdEnabled.checked = false;
byId.mdEnabled.onchange();
var plain = mdRepr("**粗体**");
check("关掉后按纯文本显示", plain === "**粗体**", plain);
check("开关状态已落盘", JSON.parse(lsData["minichat.settings.v1"]).mdEnabled === false);
byId.mdEnabled.checked = true;
byId.mdEnabled.onchange();
check("重新打开后恢复排版", mdRepr("**粗体**") === "p(strong(粗体))");

/* 用户自己发的消息不做排版 */
byId.input.value = "**我不是粗体**";
byId.input.onkeydown({ keyCode: 13, shiftKey: false, preventDefault: function () {} });
var allMsgs = byId.messages.childNodes;
check("用户消息保持原样", kidsRepr(allMsgs[allMsgs.length - 2].childNodes[1]) === "**我不是粗体**",
  kidsRepr(allMsgs[allMsgs.length - 2].childNodes[1]));
lastXhr.respond(200, JSON.stringify({ choices: [{ message: { content: "好" } }] }));

console.log("\n=========================================");
if (failures.length) { console.log("失败项 " + failures.length + " 个: " + failures.join(" | ")); process.exit(1); }
console.log("全部通过");
