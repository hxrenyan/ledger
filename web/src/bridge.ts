/**
 * 小程序 web-view 里的桥接层。
 *
 * 两种运行环境：
 * - 普通浏览器 / 微信公众号外链：`inMiniProgram === false`，这里所有函数都是空操作，
 *   对现有 H5 完全没有影响。
 * - 小程序 web-view：网页里**没有 wx.login**，拿不到 code，所以会话靠原生侧递过来的
 *   一次性交接码换（见 src/auth/handoff.ts）。跳转则通过 wx.miniProgram 调回原生页面。
 *
 * 设计取舍：不用「同域 cookie 共享」——以后服务迁到自己的服务器、API 域名可能和
 * 业务域名不同，显式交接不依赖同域假设。
 */

import type { SessionBody } from './api.ts'
import { notifyDataChange } from './refresh.ts'
import { useSession } from './stores/session.ts'

/** 查询参数名，必须和 miniprogram/utils/webview.js 里一致。 */
const HANDOFF_PARAM = 'handoff'
const WX_SDK_SRC = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'

type MiniProgramApi = {
  navigateTo(o: { url: string }): void
  switchTab(o: { url: string }): void
  reLaunch(o: { url: string }): void
  navigateBack(o?: { delta?: number }): void
  setNavigationBarTitle(o: { title: string }): void
  postMessage(o: { data: unknown }): void
}

declare global {
  interface Window {
    wx?: { miniProgram?: MiniProgramApi }
    /** 微信 JS-SDK 加载后会写入；UA 判断是启动时的主依据。 */
    __wxjs_environment?: string
  }
}

function detectMiniProgram(): boolean {
  if (typeof window === 'undefined') return false
  if (window.__wxjs_environment === 'miniprogram') return true
  // web-view 的 UA 里带 miniProgram，且在 JS-SDK 加载前就能读到，所以用它做启动判断。
  return /miniprogram/i.test(navigator.userAgent)
}

export const inMiniProgram = detectMiniProgram()

function miniApi(): MiniProgramApi | null {
  return (typeof window !== 'undefined' && window.wx && window.wx.miniProgram) || null
}

let sdkPromise: Promise<void> | null = null

/** 懒加载微信 JS-SDK：普通浏览器里不加载，不拖慢首屏。 */
function loadSdk(): Promise<void> {
  if (!inMiniProgram) return Promise.resolve()
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve) => {
      const el = document.createElement('script')
      el.src = WX_SDK_SRC
      el.onload = () => resolve()
      // 加载失败也 resolve：跳转退化成空操作，比整个页面卡住好。
      el.onerror = () => resolve()
      document.head.appendChild(el)
    })
  }
  return sdkPromise
}

// ---------------------------------------------------------------------------
// 跳回原生页面
// ---------------------------------------------------------------------------

/** 打开原生页面（非 tabBar）。 */
export function navTo(url: string): void {
  miniApi()?.navigateTo({ url })
}

/** 切到原生 tabBar 页面。 */
export function switchTab(url: string): void {
  miniApi()?.switchTab({ url })
}

/** 重开原生页面。会话失效时用它把用户丢回小程序的登录页。 */
export function reLaunch(url: string): void {
  miniApi()?.reLaunch({ url })
}

export function back(delta = 1): void {
  miniApi()?.navigateBack({ delta })
}

export function setTitle(title: string): void {
  miniApi()?.setNavigationBarTitle({ title })
}

/**
 * 给容器页发消息。注意微信只在「后退 / 组件销毁 / 分享 / 复制链接」时才投递，
 * 不是即时通道，只适合做轻提示。
 */
export function postToMiniProgram(data: unknown): void {
  miniApi()?.postMessage({ data })
}

export function toast(text: string): void {
  postToMiniProgram({ type: 'toast', text })
}

/**
 * 从原生页返回 web-view 时，网页不会重新加载、也不会重跑 setup，
 * 页面会停在离开前的旧数据上。靠 visibilitychange 补一次刷新。
 */
if (inMiniProgram && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') notifyDataChange()
  })
}

// ---------------------------------------------------------------------------
// 会话交接
// ---------------------------------------------------------------------------

async function readHandoffCode(): Promise<string> {
  const url = new URL(location.href)
  const code = url.searchParams.get(HANDOFF_PARAM)
  if (!code) return ''
  // 交接码只该出现一次，无论成败都从地址栏抹掉——分享出去的链接不能带凭据。
  url.searchParams.delete(HANDOFF_PARAM)
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  return code
}

let readyPromise: Promise<void> | null = null

/**
 * 启动前置：web-view 里先用交接码换回会话，再挂载应用。
 * 否则路由守卫会先判定「未登录」，把用户闪到 /login。
 */
export function bridgeReady(): Promise<void> {
  if (!readyPromise) readyPromise = init()
  return readyPromise
}

async function init(): Promise<void> {
  if (!inMiniProgram) return
  await loadSdk()

  const code = await readHandoffCode()
  if (!code) return
  try {
    const res = await fetch('/api/v1/auth/webview-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) return
    useSession().apply((await res.json()) as SessionBody)
  } catch {
    // 换不到会话就停在登录页；用户可以从这里跳回小程序重新进入。
  }
}
