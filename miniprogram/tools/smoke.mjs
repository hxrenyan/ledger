/**
 * 小程序加载冒烟测试。
 *
 * 为什么需要它：`node --check` 只验语法，验不到「模块顶层代码执行就抛异常」。
 * 而小程序里模块是页面加载时求值的，顶层一抛就是白屏，报错信息还指向 DevTools
 * 的编译日志，很容易被当成「编译失败」去查语法。这里用一套模拟的微信环境
 * （wx / App / Page / Component / getApp）把每个页面与组件真正 require 一遍，
 * 顺带核对 Page/Component 注册的形状是否合法。
 *
 * 用法：node miniprogram/tools/smoke.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const errors = []
const notes = []

/** 小程序框架注入到 this 上的内置方法，不需要在 Page/Component 里定义。 */
const BUILTIN_METHODS = new Set([
  // Page
  'setData',
  'selectComponent',
  'selectAllComponents',
  'groupSetData',
  'route',
  'getOpenerEventChannel',
  'setUpdatePerformanceListener',
  'selectOwnerComponent',
  'getRelationNodes',
  'hasBehavior',
  'createSelectorQuery',
  'animate',
  'clearAnimation',
  'getTabBar',
  'getPageId',
  'setData',
  'updatePerformanceListener',
  // Component
  'triggerEvent',
  'setData',
  'selectComponent',
  'selectAllComponents',
  'createSelectorQuery',
  'createIntersectionObserver',
  'getRelationNodes',
  'groupSetData',
  'getPageId',
  'hasBehavior',
  'setUpdatePerformanceListener',
])

/** 模拟的本地存储，只在一次运行内有效。 */
const storage = new Map()

/** 模拟的 wx：只实现模块加载阶段会用到的那部分，其余按需返回空实现。 */
function makeWx() {
  const noop = () => {}
  const asyncNoop = (opts = {}) => {
    if (typeof opts.success === 'function') opts.success({})
    return {}
  }
  const base = {
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    clearStorageSync: () => storage.clear(),
    getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 }),
    getSystemInfoSync: () => ({
      platform: 'devtools',
      system: 'iOS 17.0',
      model: 'iPhone 15',
      windowWidth: 390,
      windowHeight: 844,
      pixelRatio: 3,
      SDKVersion: '3.5.7',
      safeArea: { top: 47, bottom: 810, left: 0, right: 390, width: 390, height: 763 },
    }),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, pixelRatio: 3, safeArea: { top: 47, bottom: 810 } }),
    getDeviceInfo: () => ({ platform: 'devtools' }),
    getAppBaseInfo: () => ({ SDKVersion: '3.5.7', version: '8.0.0', language: 'zh_CN' }),
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wx0000000000000000', envVersion: 'develop' } }),
    login: asyncNoop,
    checkSession: asyncNoop,
    request: asyncNoop,
    showToast: noop,
    hideToast: noop,
    showLoading: noop,
    hideLoading: noop,
    showModal: (o = {}) => {
      if (typeof o.success === 'function') o.success({ confirm: false, cancel: true })
      return {}
    },
    showActionSheet: (o = {}) => {
      if (typeof o.success === 'function') o.success({ tapIndex: 0 })
      return {}
    },
    navigateTo: noop,
    redirectTo: noop,
    switchTab: noop,
    navigateBack: noop,
    reLaunch: noop,
    setNavigationBarTitle: noop,
    setClipboardData: asyncNoop,
    getClipboardData: asyncNoop,
    setStorage: asyncNoop,
    getStorage: asyncNoop,
    nextTick: (fn) => (typeof fn === 'function' ? fn() : undefined),
    canIUse: () => true,
    getRecorderManager: () => ({
      onStart: noop,
      onStop: noop,
      onError: noop,
      onFrameRecorded: noop,
      start: noop,
      stop: noop,
    }),
    getFileSystemManager: () => ({
      readFile: asyncNoop,
      writeFile: asyncNoop,
      stat: asyncNoop,
      unlink: asyncNoop,
    }),
    chooseMedia: asyncNoop,
    chooseImage: asyncNoop,
    chooseMessageFile: asyncNoop,
    previewImage: noop,
    saveFile: asyncNoop,
    openDocument: asyncNoop,
    createSelectorQuery: () => ({
      select: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([{}]) }) }),
      selectAll: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([[]]) }) }),
      in: function () {
        return this
      },
      exec: (cb) => cb && cb([]),
    }),
    pageScrollTo: noop,
    startPullDownRefresh: noop,
    stopPullDownRefresh: noop,
    vibrateShort: noop,
    setInnerAudioOption: noop,
    createInnerAudioContext: () => ({
      play: noop,
      stop: noop,
      destroy: noop,
      onEnded: noop,
      onError: noop,
      set src(v) {},
      get src() {
        return ''
      },
    }),
    requestSubscribeMessage: asyncNoop,
    requestPayment: asyncNoop,
    createWebviewContext: () => ({ postMessage: noop }),
    env: { USER_DATA_PATH: '/tmp' },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      // 未实现的 API 返回空函数，避免因缺 API 掩盖真正的错误。
      return noop
    },
    has: () => true,
  })
}

const wx = makeWx()

/** 应用到全局，因为部分模块直接引用 wx 而不是从参数取。 */
globalThis.wx = wx

/** 被注册的页面 / 组件，供形状核对。 */
const registered = { pages: [], components: [], apps: [] }

function makePage(config, file) {
  registered.pages.push({ file, config })
  return config
}
function makeComponent(config, file) {
  registered.components.push({ file, config })
  return config
}
function makeApp(config, file) {
  registered.apps.push({ file, config })
  return config
}

const moduleCache = new Map()

/** 极简 CommonJS 装载器，只支持相对/绝对路径的 .js。 */
function loadModule(file) {
  const abs = resolve(file)
  if (moduleCache.has(abs)) return moduleCache.get(abs).exports
  if (!existsSync(abs)) throw new Error(`模块不存在：${abs}`)
  const code = readFileSync(abs, 'utf8')
  const mod = { exports: {} }
  moduleCache.set(abs, mod)
  const localRequire = (rel) => {
    if (!rel.startsWith('.') && !rel.startsWith('/')) {
      throw new Error(`小程序里不支持 require 裸包名：${rel}（${abs}）`)
    }
    const target = rel.startsWith('/') ? join(ROOT, rel) : resolve(dirname(abs), rel)
    for (const cand of [target, `${target}.js`, join(target, 'index.js')]) {
      if (existsSync(cand) && statSync(cand).isFile()) return loadModule(cand)
    }
    throw new Error(`require 无法解析：${rel}（${abs}）`)
  }
  const fn = new Function(
    'module',
    'exports',
    'require',
    'wx',
    'App',
    'Page',
    'Component',
    'Behavior',
    'getApp',
    'getCurrentPages',
    code,
  )
  fn(
    mod,
    mod.exports,
    localRequire,
    wx,
    (cfg) => makeApp(cfg, abs),
    (cfg) => makePage(cfg, abs),
    (cfg) => makeComponent(cfg, abs),
    (cfg) => cfg,
    () => globalThis.__app__,
    () => [],
  )
  return mod.exports
}

/** 收集待加载的文件：app.js、所有页面 js、所有组件 js。 */
const targets = []
targets.push(join(ROOT, 'app.js'))
for (const dir of ['pages', 'components']) {
  const base = join(ROOT, dir)
  if (!existsSync(base)) continue
  for (const name of readdirSync(base)) {
    const js = join(base, name, `${name}.js`)
    if (existsSync(js)) targets.push(js)
  }
}

globalThis.__app__ = null

let loaded = 0
for (const file of targets) {
  const rel = file.slice(ROOT.length + 1)
  try {
    const exportsObj = loadModule(file)
    // App() 的返回值就是全局 app 实例，页面里的 getApp() 依赖它。
    if (rel === 'app.js') {
      const appCfg = registered.apps[registered.apps.length - 1]
      globalThis.__app__ = Object.assign({ globalData: {} }, appCfg ? appCfg.config : {}, exportsObj || {})
      // 把 onLaunch 跑一遍，捕捉启动期报错。
      if (appCfg && typeof appCfg.config.onLaunch === 'function') {
        appCfg.config.onLaunch.call(globalThis.__app__, {})
      }
    }
    loaded++
  } catch (e) {
    errors.push(`${rel}: 模块加载抛异常 -> ${e && e.message ? e.message : e}`)
  }
}

/** 核对 Page / Component 注册对象的形状。 */
function checkShape(list, kind) {
  for (const { file, config } of list) {
    const rel = file.slice(ROOT.length + 1)
    if (!config || typeof config !== 'object') {
      errors.push(`${rel}: ${kind}() 传入的不是对象`)
      continue
    }
    if (kind === 'Page') {
      if (!config.data || typeof config.data !== 'object' || Array.isArray(config.data)) {
        errors.push(`${rel}: data 必须是对象`)
      }
    }
    // Component 的自定义方法必须挂在 methods 里；Page 则直接挂顶层。
    const custom = kind === 'Component' ? config.methods || {} : config
    if (kind === 'Component' && config.methods && typeof config.methods !== 'object') {
      errors.push(`${rel}: methods 必须是对象`)
    }
    if (kind === 'Component' && !config.methods) {
      notes.push(`${rel}: Component 没有 methods，自查是否把自定义方法写到了顶层（框架不会挂到实例上）`)
    }
    for (const [key, val] of Object.entries(custom)) {
      if (val === undefined || val === null) {
        errors.push(`${rel}: ${key} 是 ${val}，小程序不接受空值成员`)
        continue
      }
      if (typeof val === 'function' || typeof val === 'object') continue
      // 原始类型出现在方法表里通常是漏写函数体或缩进错了。
      if (['string', 'number', 'boolean'].includes(typeof val)) {
        notes.push(`${rel}: 方法表里的 ${key} 是字面量（${typeof val}），自查是否漏写函数体`)
      }
    }
    // 页面/组件里调用的自定义方法是否真实存在。框架内置方法要排除，
    // 否则每个页面都会因为 this.setData() 报一次假。
    const src = readFileSync(file, 'utf8')
    const called = new Set([...src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))
    for (const name of called) {
      if (name in custom) continue
      if (kind === 'Component' && name in config) continue
      if (BUILTIN_METHODS.has(name)) continue
      errors.push(`${rel}: 调用 this.${name}() 但 Page/Component 上没有这个成员`)
    }
  }
}

checkShape(registered.apps.map((a) => ({ file: a.file, config: a.config })), 'App')
checkShape(registered.pages, 'Page')
checkShape(registered.components, 'Component')

if (!registered.pages.length) notes.push('没有注册到任何页面，检查 pages.json 路径')

console.log(`加载 ${loaded} / ${targets.length} 个模块`)
console.log(`注册：App ${registered.apps.length}、Page ${registered.pages.length}、Component ${registered.components.length}`)
if (notes.length) {
  console.log('\n提示：')
  for (const n of notes) console.log('  - ' + n)
}
if (errors.length) {
  console.log(`\n发现 ${errors.length} 个问题：`)
  for (const e of errors) console.log('  ✖ ' + e)
  process.exit(1)
}
console.log('\n全部模块加载通过，Page/Component 注册形状合法')
