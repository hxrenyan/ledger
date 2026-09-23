#!/usr/bin/env node
/**
 * 小程序静态检查：语法、JSON、页面/组件路径、require 可达性、web-view 白名单一致性。
 *
 * 微信开发者工具只有在打开项目时才报错，改了十几处路径很容易漏。这个脚本
 * 在提交前跑一遍，把「页面登记了但文件没建」「require 指向不存在的文件」
 * 这类问题在本地就暴露出来。
 *
 * 用法：node miniprogram/tools/check.mjs
 * 退出码：0 = 通过（可以有 warning），1 = 有 error
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "..");

const errors = [];
const warnings = [];

function err(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root);
const rel = (f) => relative(repoRoot, f);

// ---------------------------------------------------------------------------
// 1. JS 语法
// ---------------------------------------------------------------------------
const jsFiles = files.filter((f) => f.endsWith(".js"));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    err(`语法错误 ${rel(file)}\n${(e.stderr || "").toString().split("\n").slice(0, 4).join("\n")}`);
  }
}

// ---------------------------------------------------------------------------
// 2. JSON 可解析
// ---------------------------------------------------------------------------
const jsonFiles = files.filter((f) => f.endsWith(".json"));
const parsed = new Map();
for (const file of jsonFiles) {
  try {
    parsed.set(file, JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    err(`JSON 解析失败 ${rel(file)}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. app.json 的页面与组件都要存在
// ---------------------------------------------------------------------------
const appJsonPath = join(root, "app.json");
const appJson = parsed.get(appJsonPath);
if (!appJson) {
  err("缺少 app.json 或无法解析");
} else {
  for (const page of appJson.pages ?? []) {
    for (const ext of ["js", "json", "wxml", "wxss"]) {
      const p = join(root, `${page}.${ext}`);
      // wxss 可以缺省，其它三个是必需的。
      if (!existsSync(p)) {
        if (ext === "wxss") warn(`页面样式缺省 ${page}.wxss`);
        else err(`app.json 登记了页面但文件不存在：${page}.${ext}`);
      }
    }
  }
  for (const [name, path] of Object.entries(appJson.usingComponents ?? {})) {
    for (const ext of ["js", "json", "wxml"]) {
      const p = join(root, `${path.replace(/^\//, "")}.${ext}`);
      if (!existsSync(p)) err(`usingComponents.${name} 指向的文件不存在：${path}.${ext}`);
    }
  }
  for (const item of appJson.tabBar?.list ?? []) {
    if (!(appJson.pages ?? []).includes(item.pagePath)) {
      err(`tabBar 的 ${item.pagePath} 不在 pages 里，switchTab 会失败`);
    }
  }
  if (appJson.tabBar) {
    for (const item of appJson.tabBar.list ?? []) {
      if (!item.iconPath) {
        warn(`tabBar「${item.text}」没有图标，微信会要求补 iconPath`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. require() 的相对路径要能解析
// ---------------------------------------------------------------------------
const requireRe = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
for (const file of jsFiles) {
  const src = readFileSync(file, "utf8");
  let m;
  while ((m = requireRe.exec(src))) {
    const base = join(dirname(file), m[1]);
    const ok = existsSync(base) || existsSync(`${base}.js`) || existsSync(join(base, "index.js"));
    if (!ok) err(`${rel(file)} 里 require('${m[1]}') 找不到目标`);
  }
}

// ---------------------------------------------------------------------------
// 5. web-view 白名单：服务端能切过去的页面，客户端必须有原生兜底路径
// ---------------------------------------------------------------------------
const navSrc = readFileSync(join(root, "utils/nav.js"), "utf8");
const serverSrc = readFileSync(join(repoRoot, "src/routes/webview.ts"), "utf8");
const serverPages = [...serverSrc.matchAll(/^\s{2}(\w+): \{ mode:/gm)].map((m) => m[1]);
for (const key of serverPages) {
  if (!new RegExp(`\\b${key}:\\s*'/pages/`).test(navSrc)) {
    err(`服务端可切 web-view 的页面 ${key} 在 utils/nav.js 里没有原生兜底路径`);
  }
  if (!new RegExp(`\\b${key}: \\{ mode:`).test(readFileSync(join(root, "config.js"), "utf8"))) {
    warn(`config.js 的 fallbackPages 里没有 ${key}，服务端配置拉不到时会没有兜底`);
  }
}
if (!serverPages.length) warn("没能从 src/routes/webview.ts 解析出可切 web-view 的页面列表");

// ---------------------------------------------------------------------------
// 6. 交接码参数名两端一致
// ---------------------------------------------------------------------------
const handoffParam = readFileSync(join(root, "utils/webview.js"), "utf8").match(
  /HANDOFF_PARAM\s*=\s*['"](\w+)['"]/,
);
if (!handoffParam) {
  err("utils/webview.js 里没有 HANDOFF_PARAM");
} else {
  const bridge = readFileSync(join(repoRoot, "web/src/bridge.ts"), "utf8");
  if (!bridge.includes(`HANDOFF_PARAM = '${handoffParam[1]}'`)) {
    err(`交接码参数名两端不一致：小程序用 ${handoffParam[1]}，网页端不是`);
  }
}

// ---------------------------------------------------------------------------
// 7. WXML：标签配平 + 里不能出现的表达式
//
// 微信的 WXML 编译器只支持很窄的一套表达式。写了 Math / 箭头函数 / 模板串
// 不会给出「这一行错了」这种提示，而是整页编译失败，很难倒查，所以在本地拦掉。
// ---------------------------------------------------------------------------
const wxmlFiles = files.filter((f) => f.endsWith(".wxml"));
for (const file of wxmlFiles) {
  const src = readFileSync(file, "utf8");

  const banned = [
    [/Math\./, "Math（WXML 不提供，请在 js 里算好再 setData）"],
    [/=>/, "箭头函数"],
    [/`/, "模板字符串"],
    [/\bnew\s+(Date|Object|Array)\b/, "构造表达式"],
    [/\bJSON\./, "JSON"],
  ];
  for (const m of src.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    for (const [re, label] of banned) {
      if (re.test(m[1])) err(`${rel(file)} 的插值里用了 ${label}：{{${m[1].trim().slice(0, 60)}}}`);
    }
  }

  // 插值里不能调用函数：Page / Component 的方法不在数据作用域里，写了不会报错，
  // 只会安静地渲染成空字符串——「下拉框显示空白」就是这么来的，事后很难往这想。
  // 例外是 wxs 模块函数，用到时把模块名填进 WXS_MODULES。
  const WXS_MODULES = [];
  for (const m of src.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // 先剔掉字符串里的括号，免得 '一周（7天）' 这种内容被当成调用
    const expr = m[1]
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const call of expr.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (WXS_MODULES.includes(call[1])) continue;
      err(
        `${rel(file)} 的插值里调用了 ${call[1]}()：WXML 不支持函数调用（会安静地渲染成空），` +
          `请在 js 里算好再 setData：{{${m[1].trim().slice(0, 60)}}}`,
      );
    }
  }

  // 标签配平。先把注释和插值整体剔除，否则插值里的 > 会被当成标签结束。
  const stripped = src.replace(/<!--[\s\S]*?-->/g, "").replace(/\{\{[\s\S]*?\}\}/g, "");
  const stack = [];
  for (const m of stripped.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const [, close, name, , selfClose] = m;
    if (close) {
      if (stack[stack.length - 1] !== name) {
        err(`${rel(file)} 标签不配平：</${name}> 与 <${stack[stack.length - 1] ?? "无"}> 不匹配`);
        stack.length = 0;
        break;
      }
      stack.pop();
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length) err(`${rel(file)} 有未闭合的标签：${stack.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 8. tabBar 图标：必须存在，且微信要求不超过 40KB
// ---------------------------------------------------------------------------
if (appJson?.tabBar) {
  for (const item of appJson.tabBar.list ?? []) {
    for (const key of ["iconPath", "selectedIconPath"]) {
      const p = item[key] ? join(root, item[key]) : "";
      if (!p) continue;
      if (!existsSync(p)) {
        err(`tabBar「${item.text}」的 ${key} 不存在：${item[key]}`);
        continue;
      }
      const size = statSync(p).size;
      if (size > 40 * 1024) {
        err(`tabBar 图标超过 40KB，微信会拒绝：${item[key]}（${Math.round(size / 1024)}KB）`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 9. 每个 json 里声明的 usingComponents 都要有对应文件
// ---------------------------------------------------------------------------
for (const [file, cfg] of parsed) {
  for (const [name, path] of Object.entries(cfg?.usingComponents ?? {})) {
    const base = path.startsWith("/") ? join(root, path.slice(1)) : join(dirname(file), path);
    for (const ext of ["js", "json", "wxml"]) {
      if (!existsSync(`${base}.${ext}`)) {
        err(`${rel(file)} 的 usingComponents.${name} 缺 ${ext}：${path}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 10. 产品约定：账本切换只有「我的 → 账本与成员」一个入口
//
// 明细 / 人情 / 资产三个 tab 页不展示账本切换。这条约定很容易在后续迭代里被
// 顺手加回来（在页头放个切换条看着挺方便），所以用脚本拦住。若确实要恢复，
// 记得一并删掉这条检查，并让三个页面的 onShow 重新处理账本变化的筛选重置。
// ---------------------------------------------------------------------------
const TAB_PAGES_NO_SWITCH = ["pages/home/home", "pages/favors/favors", "pages/assets/assets"];
for (const pg of TAB_PAGES_NO_SWITCH) {
  for (const ext of ["wxml", "json"]) {
    const p = join(root, `${pg}.${ext}`);
    if (!existsSync(p)) continue;
    if (/ledger-bar/.test(readFileSync(p, "utf8"))) {
      err(
        `${rel(p)} 引用了账本切换组件：切换账本只能在「我的 → 账本与成员」里做`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 11. 月份切换条只有 components/month-nav 一处实现
//
// 演进过的三种写法，前两种都要拦住：
//   ① .month + justify-content: space-between —— 两个圆按钮被甩到屏幕两边、中间空一大片；
//   ② 页面里手写 .month-nav 药丸 —— 三个页面各一份，改一次样式要改三处，而且
//      组件样式是隔离的（app.wxss 里的类名对组件无效），写两套必然对不上；
//   ③ 现在：统一走 <month-nav> 组件（详见组件注释）。
// 箭头必须是 .ico / .ico-next 两条边框转出来的 V（不依赖字体里的 ‹ ›）。
// ---------------------------------------------------------------------------
const MONTH_NAV_WXML = join(root, "components/month-nav/month-nav.wxml");
/** 顶部该有月份切换的页面。少一个就会退回「只能一个月一个月点箭头」。 */
const MONTH_NAV_PAGES = ["pages/home/home", "pages/favors/favors", "pages/budgets/budgets"];

for (const file of wxmlFiles) {
  const src = readFileSync(file, "utf8");
  if (/class="month"/.test(src)) {
    err(`${rel(file)} 用了旧的 .month 月份条，改用 <month-nav> 组件`);
  }
  if (/class="month-nav"/.test(src) && file !== MONTH_NAV_WXML) {
    err(
      `${rel(file)} 手写了 .month-nav：月份条统一走 <month-nav> 组件` +
        `（组件样式隔离，写在页面里的这套对它是无效的）`,
    );
  }
}

{
  const src = existsSync(MONTH_NAV_WXML) ? readFileSync(MONTH_NAV_WXML, "utf8") : "";
  if (!src) {
    err("components/month-nav/month-nav.wxml 不见了（月份切换条的唯一实现）");
  } else {
    if (!/class="pill"/.test(src)) err("month-nav 组件缺少 .pill 容器");
    if (!/class="ico/.test(src)) err("month-nav 组件的箭头要用 .ico，别写 ‹ › 文字");
    if (!/mode="multiSelector"/.test(src)) {
      err("month-nav 组件少了年月滚轮：picker 应为 mode=\"multiSelector\"（否则点月份跳不了年月）");
    }
  }
  for (const pg of MONTH_NAV_PAGES) {
    const wxml = join(root, `${pg}.wxml`);
    const json = join(root, `${pg}.json`);
    if (!existsSync(wxml)) continue;
    const page = readFileSync(wxml, "utf8");
    if (!/<month-nav[\s/>]/.test(page)) {
      err(`${rel(wxml)} 少了月份切换：应使用 <month-nav> 组件`);
      continue;
    }
    if (!/bind:change="onMonthChange"/.test(page)) {
      err(`${rel(wxml)} 的 <month-nav> 没有绑定 bind:change="onMonthChange"，点月份不会生效`);
    }
    if (existsSync(json) && !/components\/month-nav\/month-nav/.test(readFileSync(json, "utf8"))) {
      err(`${rel(json)} 没有在 usingComponents 里登记 month-nav`);
    }
  }
}

// ---------------------------------------------------------------------------
// 12. 云函数不许接受客户端传入的转发目标
//
// ledgerProxy 会把请求转发到后端。如果转发原点来自 event，它就变成任何人可用的
// 任意 URL 跳板（SSRF）——原点必须写死在云函数里，或读云环境变量
// BACKEND_ORIGIN。同理 path 必须限定在 /api/ 前缀内。
// ---------------------------------------------------------------------------
const cloudFnDir = join(root, "cloudfunctions");
if (existsSync(cloudFnDir)) {
  const fnFiles = walk(cloudFnDir).filter((f) => f.endsWith(".js"));
  for (const file of fnFiles) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bevent\s*\.\s*(origin|baseUrl|base|host|url|target|domain)\b/g)) {
      err(
        `${rel(file)} 从 event 取转发目标（${m[0]}）：原点必须固定，否则云函数会被当成任意 URL 跳板`,
      );
    }
    if (!/PATH_PREFIX|["']\/api\//.test(src)) {
      err(`${rel(file)} 缺少 path 前缀校验：转发前必须限定只走 /api/`);
    }
  }
}

// ---------------------------------------------------------------------------
// 13. WXML：.row 里不能再套 .row
//
// .row 是 display:flex 的行容器。在它里面直接放 .row（尤其是 wx:for 循环出的
// 多个 .row），这些兄弟会变成同一行的 flex 子项、横向挤在一起：明细页「日历
// 点开某天，那几笔记录挤成一行」就是这个写法造成的。要竖排，就让 .row 直接
// 挂在 .card 这类普通块级容器下。
// ---------------------------------------------------------------------------
function classList(attrs) {
  const m = attrs.match(/\bclass\s*=\s*"([^"]*)"/) ?? attrs.match(/\bclass\s*=\s*'([^']*)'/);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}
const anyTagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
for (const file of wxmlFiles) {
  const src = readFileSync(file, "utf8");
  const stripped = src.replace(/<!--[\s\S]*?-->/g, "").replace(/\{\{[\s\S]*?\}\}/g, "");
  const stack = [];
  for (const m of stripped.matchAll(anyTagRe)) {
    const [, close, name, attrs, selfClose] = m;
    if (close) {
      if (stack.length && stack[stack.length - 1].name === name) stack.pop();
      else stack.length = 0;
      continue;
    }
    if (selfClose) continue;
    const isRow = name === "view" && classList(attrs).includes("row");
    const parent = stack[stack.length - 1];
    if (isRow && parent && parent.isRow) {
      err(
        `${rel(file)} 的 .row 里直接套了 .row：两者都是 flex 行，内层会横向挤成一行` +
          `（去掉外层 .row，或改用普通容器）`,
      );
    }
    stack.push({ name: name, isRow: isRow });
  }
}

// ---------------------------------------------------------------------------
// 14. 登录页必须保留「切回线上」的逃生口
//
// 环境（本地 / 线上）存在本地缓存里，切换入口在「我的 → 开发者 → 环境」，
// 而那页要登录之后才进得去。一旦误切成指向 127.0.0.1 的「本地」，登录请求就
// 发不出去 → 回不到「我的」→ 改不回来，整个小程序锁死在登录页。
// 所以登录页必须能显示当前指向并一键切回线上，且这个出口看着「像测试代码」，
// 很容易在后续清理时被当成没用的东西删掉，用脚本钉住。
// ---------------------------------------------------------------------------
{
  const loginJs = join(root, "pages/login/login.js");
  const loginWxml = join(root, "pages/login/login.wxml");
  if (existsSync(loginJs) && !/config\s*\.\s*setEnv\s*\(/.test(readFileSync(loginJs, "utf8"))) {
    err("pages/login/login.js 少了切回线上的能力（config.setEnv）：误切到本地环境会把自己锁在登录页");
  }
  if (existsSync(loginWxml) && !/bindtap="backToProd"/.test(readFileSync(loginWxml, "utf8"))) {
    err('pages/login/login.wxml 少了「切回线上」按钮（bindtap="backToProd"）');
  }
}

// ---------------------------------------------------------------------------
// 15. WXML 插值里点号左边的标识符必须真的存在
//
// wx:for 的默认变量名是 item。写成别的名字（例如 {{cell.day}}）却没声明
// wx:for-item="cell"，编译不报错，只是安静地取到 undefined —— 日历格子会渲染成
// 一排没有数字的空框（用户报的「日历一片空白」就是漏了 wx:for-item）。
//
// 做法：把「插值里出现 X.」的 X 收集起来，要求它是 js 里的对象键（data /
// properties / setData 都会命中），或者是某个 wx:for-item / wx:for-index 的名字。
// 收集键名故意放宽（js 里任何对象字面量键都算），宁可漏报也不误报。
// ---------------------------------------------------------------------------
const WXML_BUILTIN = new Set(["item", "index", "true", "false", "null", "undefined", "NaN"]);
for (const file of wxmlFiles) {
  const src = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const jsPath = file.replace(/\.wxml$/, ".js");
  const js = existsSync(jsPath) ? readFileSync(jsPath, "utf8") : "";

  const declared = new Set();
  for (const m of js.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g)) declared.add(m[1]);
  for (const m of src.matchAll(/wx:for-(?:item|index)\s*=\s*"([^"]+)"/g)) declared.add(m[1]);

  const unknown = new Map();
  for (const m of src.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // 先剔掉字符串字面量，免得把 'has' 这种当成标识符
    const expr = m[1].replace(/'[^']*'|"[^"]*"/g, "");
    for (const id of expr.matchAll(/\b([A-Za-z_$][\w$]*)\s*\./g)) {
      const name = id[1];
      if (WXML_BUILTIN.has(name) || declared.has(name)) continue;
      unknown.set(name, (unknown.get(name) || 0) + 1);
    }
  }
  for (const [name, n] of unknown) {
    err(
      `${rel(file)} 插值里的 ${name} 未声明（出现 ${n} 次）：data / properties 里没有这个键，` +
        `也不是 wx:for-item 的名字。常见原因是 wx:for 忘了写 wx:for-item="cell"，` +
        `此时 {{cell.xxx}} 会安静地取到 undefined（不报错、只是渲染成空）`,
    );
  }
}

// ---------------------------------------------------------------------------
// 16. 拍照只能走 utils/image.js
//
// 绕开它的直接后果是**没有体积守卫**：手机直出的照片动辄 3–8MB，直连会被后端
// 6MB 上限打回，云通道更塞不进 callFunction 的 event（约 1MB）——症状就是
// 「开发者工具里好好的，体验版拍照必失败」，而且报错发生在服务端，很难联想到
// 客户端没压图。统一入口还有一个用：压缩梯度、体积上限都只在这里一处定义。
// ---------------------------------------------------------------------------
const IMAGE_UTIL = join(root, "utils", "image.js");
for (const file of jsFiles) {
  if (file === IMAGE_UTIL) continue;
  const src = readFileSync(file, "utf8");
  for (const api of ["chooseMedia", "chooseImage", "compressImage"]) {
    if (new RegExp(`wx\\s*\\.\\s*${api}\\s*\\(`).test(src)) {
      err(`${rel(file)} 直接调了 wx.${api}()：选图 / 压缩只能走 utils/image.js（那里有体积守卫）`);
    }
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log(`检查 ${files.length} 个文件（${jsFiles.length} 个 js / ${jsonFiles.length} 个 json）`);
for (const w of warnings) console.log(`  warning  ${w}`);
for (const e of errors) console.log(`  ERROR    ${e}`);
if (errors.length) {
  console.log(`\n${errors.length} 个错误，${warnings.length} 个警告`);
  process.exit(1);
}
console.log(`\n通过，${warnings.length} 个警告`);
