# MiniChat —— 极简 DeepSeek 对话网页

不依赖任何框架、不需要构建、不需要后端的单页聊天工具。API Key 由使用者自己在页面上填写。
**以手机体验为主**，同时为老浏览器（Safari 12 / 2018 年左右的浏览器）编写，因此刻意牺牲外观，
只保留最基础的对话功能。

截图：

| | 浅色 | 深色 |
| --- | --- | --- |
| **手机** | ![手机浅色](doc/mobile-chat.png) | ![手机深色](doc/mobile-chat-dark.png) |
| **手机 · 菜单抽屉** | ![手机抽屉浅色](doc/mobile-drawer.png) | ![手机抽屉深色](doc/mobile-drawer-dark.png) |
| **电脑** | ![电脑浅色](doc/desktop.png) | ![电脑深色](doc/desktop-dark.png) |

## 使用方法

### 手机上（推荐这样用）

手机浏览器不方便打开本地文件，所以用电脑当静态服务器、手机同网访问：

```bash
cd minichat
python3 -m http.server 8000
```

- 电脑：浏览器打开 `http://127.0.0.1:8000/`
- 手机（连同一个 Wi-Fi）：打开 `http://<电脑的局域网IP>:8000/`

查电脑局域网 IP：macOS 用 `ipconfig getifaddr en0`，Linux 用 `hostname -I`。

iPhone 上可以再点「分享 → 添加到主屏幕」，之后从桌面图标打开是全屏的（页面已带
`apple-mobile-web-app-capable`），而且不会被 Safari「7 天没访问就清理存储」的策略清掉聊天记录。

### 电脑上

直接双击 `index.html` 也能用（`file://` 打开已实测可正常调用 DeepSeek 接口）。

### 然后

1. 点左上角 **☰ 菜单** 打开侧栏，填入 **DeepSeek API Key**（形如 `sk-xxxx`），点 **保存设置**。
2. 输入内容，按键盘上的**发送键** / 点 **发送**。

> 不点“保存设置”直接发送也可以，发送时会自动同步侧栏里的内容。

## 部署到 GitHub Pages

**可以直接传，不用改任何代码**：纯静态、无构建步骤、无后端，所有引用都是相对路径，
放在仓库根目录或子目录都能正常工作（已用子路径模拟验证过）。

```bash
cd minichat
git init && git add . && git commit -m "minichat"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

然后仓库 **Settings → Pages → Source** 选 `Deploy from a branch`，分支选 `main` / 目录选 `(root)`，
等一两分钟访问 `https://<你的用户名>.github.io/<仓库名>/`。

几点说明：

- **不用怕公开仓库**：API Key 是访问者在自己的浏览器里填的，不写在代码里，所以不会泄露。
  唯一要小心的是别把 Key 直接写进文件再 push。
- **HTTPS 没有混合内容问题**：Pages 是 https，接口也是 https。
- **已实测**：接口的 CORS 会回显 `https://<用户名>.github.io` 这个来源，浏览器可以直连。
  也就是说部署到 Pages 比用 `file://` 双击打开更省心（Pages 是正常的 http(s) 来源）。
- **`.nojekyll`**：一个空文件，让 Pages 跳过 Jekyll 处理。本项目文件名不含下划线，
  其实不加也能跑，加上是为了以后新增文件时少踩坑。
- **`test/` 和 `doc/` 可以不传**：前者是 Node 测试、后者是截图，删掉不影响页面运行。
- **一个安全提醒**：`localStorage` 按**来源**隔离，`https://<用户名>.github.io` 下所有仓库
  共用同一份存储。所以如果 Key 存在别人部署的 Pages 上，那个页面理论上也能读到；
  用自己的仓库、或把「记住 Key」勾掉（Key 只在本次会话有效）就没这个问题。

## 手机上的交互

- **抽屉式侧栏**：整个侧栏默认收起，点 ☰ 呼出，点空白处或选中对话后自动收起。
  这样进来看到的就是聊天内容，不是一大片设置项。
- **侧栏里历史对话在最上面**：打开侧栏先看到对话列表，以及并排的「＋ 新对话 / 清空当前对话」；
  设置收在下面的「设置」里，点标题栏即可展开 / 收起。
- **设置默认展开还是收起，取决于你填没填 Key**：没填就自动展开并标红「需要填写 API Key」
  （否则新用户根本找不到填 Key 的地方）；填过就默认收起，把位置让给对话列表。
  你手动点过一次之后，就按你的选择记住。没填 Key 时点发送也会自动帮你展开设置。

第一次打开（还没填 Key）长这样：

![首次打开](doc/mobile-drawer-firstrun.png)
- **换行按钮**：手机键盘没有 Shift，所以单独给了一个 **↵ 换行** 按钮（电脑上隐藏，用 Shift+Enter）。
- **输入框不会掉到键盘后面**：手机上不用 `position:fixed` 固定输入框，而是让它待在正常文档流里。
  老 iOS Safari 对固定定位元素遇键盘的处理不可靠（容易被键盘盖住），用文档流则由系统
  自动把输入框滚到键盘上方——这是老系统上最稳的做法。
- **字号 16px**：iOS 上输入框字号小于 16px 时，聚焦会自动放大整个页面。所有输入控件都是 16px。
- **触摸目标**：按钮、对话条目、删除×都是 44px 级别，手指点得中。
- **不被消息拽着跑**：你往上翻看历史时，新回答不会强行把你拉回底部（只在你自己发消息、
  或在底部附近时才自动滚动）；离底部较远时右下角会出现 **↓** 回到底部。
- **刘海屏**：`viewport-fit=cover` + `safe-area-inset`，顶栏和输入区不会被刘海/home 指示条压住。
- 提示信息会自动消失，不长期占着顶栏。

## 深色模式

- **顶栏右上角一键切换**：按钮显示 ☾ 表示当前是浅色（点一下变深），☀ 表示当前是深色。
- **侧栏「外观」三选一**：跟随系统 / 浅色 / 深色，选择立即生效并保存。
- 选择存在 `minichat.settings.v1` 里，刷新、重开浏览器都保留。
- 切换时连手机状态栏颜色（`<meta name="theme-color">`）一起改，老浏览器忽略这条。

兼容性处理：

| 点 | 做法 | 老浏览器会怎样 |
| --- | --- | --- |
| 颜色怎么切 | 只切 `<html>` 上的 `class`，颜色全写在 CSS 的 `html.dark` 作用域里 | `className` 是最古老的能力，任何浏览器都行 |
| 为什么不用 CSS 变量 | `var()` 要 Safari 9.1 / Android 4.4+ | 变量化写法在更老的浏览器上会变成**没有颜色**的页面，所以宁可多写几十行 |
| 打开瞬间闪白 | `<head>` 里一段内联脚本，在首次绘制前就把 class 定好 | 纯 ES5，失败也只是退回浅色 |
| 跟随系统 | `prefers-color-scheme`（Safari 12.1+ 才有） | 不支持时一律按浅色，手动切深色照常可用 |
| 原生控件/滚动条 | CSS `color-scheme` | 不认识就忽略，输入框和下拉框颜色由我们的 CSS 决定 |
| 输入框占位符 | 给 `::-webkit-input-placeholder` / `::-moz-placeholder` 各写一条 | 前缀选择器分别写，避免其中一条不认识导致整条规则被丢弃 |

## 功能

- 用户输入 → AI 回答，多轮上下文（每次最多带最近 30 条，节省 token）
- API Key / 模型 / 系统提示词 / 接口地址 / 外观都在侧栏「设置」里（可折叠）
- 模型可选 `deepseek-chat` 与 `deepseek-reasoner`（推理模型的思考过程以灰色小字单独显示）
- **新开对话**：多个对话可切换、删除
- **清空当前对话**
- **聊天记录持久化**：存在浏览器 `localStorage`，关页面、重启浏览器都还在
- 错误分类提示：Key 无效 401、余额不足 402、限流 429、超时、网络/跨域失败等
- 回答以**纯文本**显示（不做 Markdown 排版），简单且不会被注入 HTML

## 兼容性说明（为什么这么写）

代码严格使用 ES5，刻意避开老浏览器不支持的特性：

| 没有使用 | 替代方案 |
| --- | --- |
| `let`/`const`/箭头函数/模板字符串 | `var` + 普通函数 + 字符串拼接 |
| `fetch`/`Promise`/`async`/`await` | `XMLHttpRequest` + 回调 |
| CSS flex/grid/变量/动画/transform | `float` + `position` + 简单盒模型 |
| `classList`/`closest`/`Element.remove()` | `className` 字符串、手工遍历 `parentNode` |
| `Array.prototype.includes`/`Object.assign` | `indexOf` / 手工拷贝属性 |
| `-webkit-appearance:none` | 保留原生控件外观（下拉箭头等是重要的交互提示） |

样式表是**移动优先**的：基础样式就是手机单列布局，`min-width:701px` 才切到桌面左右分栏。
这样即使浏览器不支持媒体查询，拿到的也是能用的单列版。

少数用到的现代能力都做了降级：`XMLHttpRequest.timeout`（不存在就跳过）、
`KeyboardEvent.isComposing`（同时用 `keyCode === 229` 兼容，中文输入法选词时不会误发送）、
`window.matchMedia`（不存在则退回按 `innerWidth` 判断）、
`safe-area-inset`（`calc()+env()` 不支持时整条声明被忽略，退回普通 padding）。

刻意**没有**做的两件事：输入框自动增高、消息 Markdown 渲染 —— 多一处 JS 干预就多一处老 iOS 上的
不确定性，收益不抵风险。

## 数据存在哪里

| 键 | 内容 |
| --- | --- |
| `minichat.settings.v1` | API Key、模型、系统提示词、接口地址、外观（深/浅/跟随系统）、设置的展开/收起状态 |
| `minichat.conversations.v1` | 所有对话与消息 |
| `minichat.current.v1` | 当前选中的对话 |

Key 以**明文**存在本机浏览器里；侧栏的「记住 Key」可以关掉，关掉后 Key 只在本次会话有效。
在意安全就别勾选。

Safari 无痕模式下 `localStorage` 不可用，页面会自动退化为“仅本次会话有效”的内存存储，
功能照常，刷新后记录丢失，页面上有提示。存储写满时会自动丢弃最旧的对话（当前对话永不丢）。

## 常见问题

**401 API Key 无效**：Key 填错或带空格，重新完整复制 `sk-` 开头的 Key 再保存。

**402 余额不足**：到 DeepSeek 开放平台充值。

**网络错误 / 无法连接**：多为网络或企业代理拦截。DeepSeek 官方接口本身允许浏览器直连
（`Access-Control-Allow-Origin` 会回显来源，包括 `file://` 的 `null`），通常是本机网络、代理软件
或浏览器扩展导致。确实需要代理时，可在「接口地址」填自己的兼容地址（只填域名，程序会自动
补 `/chat/completions`）。最简 Node 反向代理（Node 18+）：

```js
// node proxy.js
var http = require("http");
http.createServer(function (req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "POST"
    });
    return res.end();
  }
  var chunks = [];
  req.on("data", function (c) { chunks.push(c); });
  req.on("end", function () {
    fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": req.headers.authorization || "" },
      body: Buffer.concat(chunks).toString("utf8")
    }).then(function (r) {
      return r.text().then(function (t) {
        res.writeHead(r.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(t);
      });
    });
  });
}).listen(8787, function () { console.log("proxy on http://127.0.0.1:8787"); });
```

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面结构 |
| `app.js` | 全部逻辑（ES5） |
| `style.css` | 样式（移动优先、老浏览器安全写法） |
| `test/smoke.js` | 桩件测试，`node test/smoke.js` 运行，不影响页面使用 |
| `doc/*.png` | 截图（用 headless Firefox 渲染真实页面生成） |
| `.nojekyll` | 空文件，让 GitHub Pages 跳过 Jekyll 处理 |

`test/smoke.js` 用最小 DOM/localStorage/XHR 桩件跑真实 `app.js`，覆盖 98 项断言：
发送/接收、各类错误、新建/切换/清空/删除、刷新恢复、无痕模式降级、存储配额不足裁剪、
输入法组合期不误发、移动端抽屉与「回到底部」、横竖屏切换后内联样式清理、
深色模式（跟随系统 / 一键切换 / 落盘恢复 / 非法值兜底 / 没有 matchMedia 时不报错）、
设置折叠（默认策略 / 手动选择被记住 / 没填 Key 时发送自动展开）等。
