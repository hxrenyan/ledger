/**
 * H5 压图的**决策**部分：压几档、从哪一档开始。纯函数，不碰 DOM。
 *
 * 为什么与 canvas 那半边分成两个文件（执行部分是 web/src/photo.ts）：
 *   1. 决策错了是**静默**的 —— 起点档位选小了会白压几轮，用户只看到「处理照片…」
 *      等半天，没人知道为什么。所以它必须能被单测直接 import；而 `test/` 是用
 *      Workers 的 tsconfig 跑的（根 tsconfig 的 lib 只有 ES2022），那里没有
 *      `document` / `HTMLImageElement`，引进来整个 typecheck 就会红。
 *   2. 这份梯度与 `miniprogram/utils/image.js` 是**同一套**，两边必须一起改，
 *      `test/web-photo.test.ts` 有一条跨端一致性断言钉着。
 */

export type Step = { quality: number; scale: number }

/**
 * 压缩梯度：先降质量，再降分辨率。
 *
 * 顺序不能反 —— 小票上真正要紧的是数字，先缩图会先把它糊掉。
 * 质量降到底还在阈值外，才动分辨率。
 * （数值与小程序那份一致，只是 canvas 的 quality 是 0–1，wx 那边是 0–100。）
 */
export const STEPS: Step[] = [
  { quality: 0.82, scale: 1 },
  { quality: 0.7, scale: 1 },
  { quality: 0.62, scale: 0.75 },
  { quality: 0.5, scale: 0.55 },
]

const BASE_QUALITY = STEPS[0].quality

/** 后端收 6MB（src/routes/ocr.ts 的 MAX_IMAGE_BYTES），这里压到 3MB 以内：留一半余量。 */
export const PHOTO_LIMIT = 3 * 1024 * 1024

/**
 * 粗略估算压缩后的字节数。**只用来决定从哪一档开始试**，不作为结论：
 * JPEG 的实际压缩率跟画面内容强相关（一片白底的小票能压到 1/10，复杂场景可能
 * 只压到 1/2），估得准反而会让代码误以为能一次到位。
 */
export function estimate(size: number, step: Step): number {
  const n = Number(size) || 0
  if (n <= 0) return 0
  const byQuality = Math.pow(step.quality / BASE_QUALITY, 1.4)
  return Math.round(n * byQuality * step.scale * step.scale)
}

/**
 * 起始档位下标：第一个估算能落进 limit 的档，再往前让一档起试。
 *
 * 为什么要让一档：估算按「画面复杂」的最坏情况算，偏保守；而多压一轮只多花
 * 一两百毫秒，压过头却是永久损失清晰度（小票上的数字就糊了）。
 * 让到 0 就是从头试。体积未知时也从 0 开始。
 */
export function startStep(size: number, limit: number): number {
  if (!(limit > 0)) return 0
  for (let i = 0; i < STEPS.length; i += 1) {
    if (estimate(size, STEPS[i]) <= limit) return Math.max(0, i - 1)
  }
  return STEPS.length - 1
}

/** 从某档开始的完整尝试序列。下标越界（负数或超出末尾）时回落到从头开始。 */
export function stepsFrom(index: number): Step[] {
  const ok = index >= 0 && index <= STEPS.length
  return STEPS.slice(ok ? index : 0)
}
