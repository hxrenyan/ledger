/**
 * H5 拍照压图的纯逻辑测试。
 *
 * 测的是 web/src/photoSteps.ts（决策部分）而不是 photo.ts（canvas 执行部分）：
 * `test/` 是用根 tsconfig 跑的，lib 只有 ES2022、没有 DOM，import 带 canvas 的模块
 * 会让 `npm run typecheck` 直接红。canvas 那半边靠真机行为收敛（prepare 逐档压完
 * 再核对实际体积），这里钉住的是「怎么决定」的那一半 —— 决策错了是静默的，
 * 会白压几轮，用户只看到「处理照片…」很久。
 *
 * 与 test/miniprogram-image.test.ts 是同一批断言的镜像，另外多一条**两端一致性**：
 * 小程序和 H5 各有一份压缩梯度，只改一边就会让同一个人在两个入口拿到不同的画质，
 * 而且这种偏差不报错、只表现为「网页上认得出、小程序上认不出」。这条钉住它们一起改。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PHOTO_LIMIT, STEPS, estimate, startStep, stepsFrom } from '../web/src/photoSteps.ts'

type Module = Record<string, unknown>

/** 小程序源码是 CommonJS、仓库是 ESM，所以手工跑（与 miniprogram-utils.test.ts 同套路）。 */
function loadCjs(file: string, cache = new Map<string, Module>()): Module {
  const hit = cache.get(file)
  if (hit) return hit
  const mod: { exports: Module } = { exports: {} }
  cache.set(file, mod.exports)
  const localRequire = (spec: string) => {
    if (!spec.startsWith('.')) throw new Error(`小程序模块不应依赖外部包：${spec}`)
    const target = resolve(dirname(file), spec.endsWith('.js') ? spec : `${spec}.js`)
    return loadCjs(target, cache)
  }
  const fn = new Function('module', 'exports', 'require', readFileSync(file, 'utf8'))
  fn(mod, mod.exports, localRequire)
  cache.set(file, mod.exports)
  return mod.exports
}

const mpImage = loadCjs(
  resolve(process.cwd(), 'miniprogram/utils/image.js'),
) as unknown as { STEPS: { quality: number; scale: number }[] }

const KB = 1024
/** src/routes/ocr.ts 的 MAX_IMAGE_BYTES：服务端硬上限。 */
const SERVER_LIMIT = 6 * 1024 * KB

describe('H5 拍照压图：压缩梯度', () => {
  it('顺序是「先降质量、再降分辨率」', () => {
    expect(STEPS.map((s) => s.scale)).toEqual([1, 1, 0.75, 0.55])
    for (let i = 1; i < STEPS.length; i += 1) {
      expect(STEPS[i].quality).toBeLessThan(STEPS[i - 1].quality)
      expect(STEPS[i].scale).toBeLessThanOrEqual(STEPS[i - 1].scale)
    }
  })

  it('与小程序那份保持一致（改一边就必须改另一边）', () => {
    // 小程序用 0–100、canvas 用 0–1，所以质量取整后应当逐个对上。
    expect(STEPS.map((s) => Math.round(s.quality * 100))).toEqual(mpImage.STEPS.map((s) => s.quality))
    expect(STEPS.map((s) => s.scale)).toEqual(mpImage.STEPS.map((s) => s.scale))
    expect(STEPS.length).toBe(mpImage.STEPS.length)
  })

  it('估算体积随档位单调变小、与输入成正比', () => {
    const size = 4 * 1024 * KB
    const vals = STEPS.map((s) => estimate(size, s))
    for (let i = 1; i < vals.length; i += 1) {
      expect(vals[i]).toBeLessThan(vals[i - 1])
    }
    const step = STEPS[1]
    expect(estimate(2 * 1024 * KB, step)).toBeCloseTo(estimate(1024 * KB, step) * 2, -3)
  })
})

describe('H5 拍照压图：起点档位', () => {
  it('体积已在预算内：从第 0 档开始（仍然压一次，顺带统一成 jpg）', () => {
    // 不返回「不用压」是故意的：png 截图有透明区，转 jpeg 前要铺白底，
    // 而且这一步通常还能再省一半体积。
    expect(startStep(200 * KB, PHOTO_LIMIT)).toBe(0)
    expect(startStep(2 * 1024 * KB, PHOTO_LIMIT)).toBe(0)
  })

  it('体积越大起点越狠，但常规照片不该一上来就用最狠的档', () => {
    const small = startStep(1 * 1024 * KB, PHOTO_LIMIT)
    const big = startStep(20 * 1024 * KB, PHOTO_LIMIT)
    expect(big).toBeGreaterThanOrEqual(small)
    // 手机直出常见 3–8MB，压到 3MB 预算属于「降质量就够」，不该动分辨率。
    const common = startStep(4 * 1024 * KB, PHOTO_LIMIT)
    expect(common).toBeLessThan(STEPS.length - 1)
  })

  it('怎么估都超标时退到最狠的一档，不返回越界下标', () => {
    const worst = startStep(50 * 1024 * KB, 512 * KB)
    expect(worst).toBe(STEPS.length - 1)
    // 起点必须落在梯度里：drawStep 拿到 undefined 档位会在运行时直接炸。
    expect(STEPS[worst]).toBeTruthy()
  })

  it('体积未知或 limit 非法都从第 0 档开始', () => {
    expect(startStep(0, PHOTO_LIMIT)).toBe(0)
    expect(startStep(-1, PHOTO_LIMIT)).toBe(0)
    expect(startStep(10 * 1024 * KB, 0)).toBe(0)
    expect(startStep(10 * 1024 * KB, -1)).toBe(0)
  })

  it('步骤序列从起点切到末尾，越界下标回落到 0', () => {
    expect(stepsFrom(0).length).toBe(STEPS.length)
    expect(stepsFrom(2).length).toBe(STEPS.length - 2)
    expect(stepsFrom(STEPS.length)).toEqual([])
    expect(stepsFrom(99)).toEqual(STEPS)
    expect(stepsFrom(-3)).toEqual(STEPS)
  })
})

describe('H5 拍照压图：预算', () => {
  it('目标体积留在服务端上限以内（别贴边）', () => {
    expect(PHOTO_LIMIT).toBeLessThan(SERVER_LIMIT)
    expect(PHOTO_LIMIT).toBeGreaterThan(512 * KB)
  })
})
