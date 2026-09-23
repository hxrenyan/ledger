/**
 * 拍照压图的纯逻辑测试。
 *
 * 为什么单独测这块：压缩这条链路的错误全是**静默**的 ——
 *   · 起点档位选小了：白压几轮，用户对着「处理照片…」等半天，没人知道为什么；
 *   · 起点档位越界：compress 拿到 undefined 档位，直接抛在运行时；
 *   · 梯度顺序写反（先缩图再降质）：小票上的数字先被糊掉，压出来体积反而更大；
 *   · 类型判定错：multipart 分片的 Content-Type 与内容不符，模型侧行为不可预期。
 * 真机行为靠 prepare() 逐档收敛，这里钉住的是「怎么决定」的那一半。
 *
 * 装载方式与 test/miniprogram-utils.test.ts 一致：小程序源码是 CommonJS，
 * 仓库是 ESM，所以用 new Function 手工跑（image.js 顶层不碰 wx，纯函数可直接调）。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type Module = Record<string, unknown>

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

const utilsDir = resolve(process.cwd(), 'miniprogram/utils')

const image = loadCjs(resolve(utilsDir, 'image.js')) as unknown as {
  STEPS: { quality: number; scale: number }[]
  estimate(size: number, step: { quality: number; scale: number }): number
  startStep(size: number, limit: number): number
  stepsFrom(index: number): { quality: number; scale: number }[]
  mimeOf(bytes: Uint8Array): string
}

const KB = 1024
const CLOUD_LIMIT = 600 * KB
const RECEIPT_LIMIT = 512 * KB

describe('拍照压图：压缩梯度', () => {
  it('顺序是「先降质量、再降分辨率」', () => {
    // 小票上真正要读的是数字，先缩图会先把它糊掉 —— 顺序反了体积还未必更小。
    expect(image.STEPS.map((s) => s.scale)).toEqual([1, 1, 0.75, 0.55])
    expect(image.STEPS.map((s) => s.quality)).toEqual([82, 70, 62, 50])
    for (let i = 1; i < image.STEPS.length; i += 1) {
      expect(image.STEPS[i].quality).toBeLessThan(image.STEPS[i - 1].quality)
      expect(image.STEPS[i].scale).toBeLessThanOrEqual(image.STEPS[i - 1].scale)
    }
  })

  it('估算体积随档位单调变小', () => {
    const size = 4 * 1024 * KB
    const vals = image.STEPS.map((s) => image.estimate(size, s))
    for (let i = 1; i < vals.length; i += 1) {
      expect(vals[i]).toBeLessThan(vals[i - 1])
    }
  })

  it('估算与输入体积成正比', () => {
    const step = image.STEPS[1]
    expect(image.estimate(2 * 1024 * KB, step)).toBeCloseTo(image.estimate(1024 * KB, step) * 2, -3)
  })
})

describe('拍照压图：起点档位', () => {
  it('体积已在预算内：从第 0 档开始（仍然压一次，顺带统一成 jpg）', () => {
    // 不返回「不用压」是故意的：png / heic 统一成 jpg 后模型那边更稳，
    // 而且这一步通常还能再省一半体积。
    expect(image.startStep(200 * KB, 3 * 1024 * KB)).toBe(0)
    expect(image.startStep(500 * KB, RECEIPT_LIMIT)).toBe(0)
  })

  it('体积越大，起点越狠（至少不比小的更浅）', () => {
    const small = image.startStep(1 * 1024 * KB, CLOUD_LIMIT)
    const big = image.startStep(8 * 1024 * KB, CLOUD_LIMIT)
    expect(big).toBeGreaterThanOrEqual(small)
  })

  it('怎么估都超标时退到最狠的一档，不返回越界下标', () => {
    expect(image.startStep(50 * 1024 * KB, 512 * KB)).toBe(image.STEPS.length - 1)
    // 起点必须是合法下标：compress() 拿到 undefined 档位会在运行时直接炸。
    expect(image.STEPS[image.startStep(50 * 1024 * KB, 512 * KB)]).toBeTruthy()
  })

  it('常规手机照片走云通道：起点在中段，不一上来就用最狠的档', () => {
    // chooseMedia 带 sizeType:'compressed' 之后，常见落点是 0.3–1.5MB。
    // 1.2MB 在 600KB 预算下应该落在中段，而不是直接吃最差画质。
    const start = image.startStep(1.2 * 1024 * KB, CLOUD_LIMIT)
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThan(image.STEPS.length - 1)
  })

  it('真正的大图会被推到最狠的档（这是取舍，不是 bug）', () => {
    // 4MB 要落进云通道 600KB 的预算，只降质量已经不够，必须同时降分辨率。
    // 真机上到这一步的概率不高（微信的 compressed 已先压过一道），
    // 到了也只能接受画质损失 —— 否则连传都传不出去。
    expect(image.startStep(4 * 1024 * KB, CLOUD_LIMIT)).toBe(image.STEPS.length - 1)
  })

  it('体积未知从第 0 档开始；limit 非法也不越界', () => {
    expect(image.startStep(0, 3 * 1024 * KB)).toBe(0)
    expect(image.startStep(-1, 3 * 1024 * KB)).toBe(0)
    expect(image.startStep(10 * 1024 * KB, 0)).toBe(0)
    expect(image.startStep(10 * 1024 * KB, -1)).toBe(0)
  })

  it('步骤序列从起点切到末尾，越界下标回落到 0', () => {
    expect(image.stepsFrom(0).length).toBe(image.STEPS.length)
    expect(image.stepsFrom(2).length).toBe(image.STEPS.length - 2)
    expect(image.stepsFrom(image.STEPS.length)).toEqual([])
    expect(image.stepsFrom(99)).toEqual(image.STEPS)
    expect(image.stepsFrom(-3)).toEqual(image.STEPS)
  })
})

describe('拍照压图：按文件头认类型', () => {
  const head = (...bytes: number[]) => new Uint8Array(bytes)

  it('认得出 jpeg / png / webp / bmp', () => {
    expect(image.mimeOf(head(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe('image/jpeg')
    expect(image.mimeOf(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(
      image.mimeOf(head(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)),
    ).toBe('image/webp')
    expect(image.mimeOf(head(0x42, 0x4d, 0, 0, 0, 0, 0, 0))).toBe('image/bmp')
  })

  it('认不出或读失败时按 jpeg 报（相机直出就是它）', () => {
    expect(image.mimeOf(new Uint8Array(0))).toBe('image/jpeg')
    expect(image.mimeOf(head(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))).toBe('image/jpeg')
    // 只有 2 个字节时不能越界读取
    expect(image.mimeOf(head(0xff, 0xd8))).toBe('image/jpeg')
  })
})
