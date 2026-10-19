/**
 * 端侧认字里能离线钉住的那一半：缩放、文字块排序、够不够长、像素缓冲。
 * recognize() 依赖微信 VisionKit，这里不跑。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type LocalOcr = {
  MAX_EDGE: number
  MIN_MEANINGFUL: number
  fitSize(width: number, height: number, maxEdge?: number): { width: number; height: number } | null
  joinAnchors(anchors: unknown): string
  meaningfulCount(text: string): number
  usable(text: string): boolean
  rgbaBuffer(data: ArrayLike<number> | null, width: number, height: number): ArrayBuffer | null
  photoAvailable(serverReady: boolean): boolean
  supported(): boolean
}

function loadLocalOcr(): LocalOcr {
  const file = resolve(process.cwd(), 'miniprogram/utils/localOcr.js')
  const mod: { exports: LocalOcr } = { exports: {} as LocalOcr }
  const fn = new Function('module', 'exports', 'require', readFileSync(file, 'utf8'))
  fn(mod, mod.exports, () => {
    throw new Error('localOcr.js 不应依赖其它模块')
  })
  return mod.exports
}

const ocr = loadLocalOcr()

describe('端侧认字：缩放', () => {
  it('长边已经在上限内时保持原尺寸', () => {
    expect(ocr.fitSize(800, 600, 1280)).toEqual({ width: 800, height: 600 })
  })

  it('长边超过上限时按比例缩小，长边落到上限', () => {
    expect(ocr.fitSize(3000, 4000, 1280)).toEqual({ width: 960, height: 1280 })
  })

  it('极窄的长图不会把短边收成 0', () => {
    expect(ocr.fitSize(100, 5000, 1280)).toEqual({ width: 26, height: 1280 })
  })

  it('宽或高不是正数时不建画布', () => {
    expect(ocr.fitSize(0, 100, 1280)).toBeNull()
    expect(ocr.fitSize(100, 0, 1280)).toBeNull()
  })
})

describe('端侧认字：文字块', () => {
  it('没有坐标时保持微信返回的顺序', () => {
    expect(
      ocr.joinAnchors([
        { text: '合计' },
        { text: '  35.00  ' },
        { text: '   ' },
      ]),
    ).toBe('合计\n35.00')
  })

  it('每块都有坐标时从上到下、从左到右', () => {
    expect(
      ocr.joinAnchors([
        { text: '右下', origin: { x: 40, y: 80 } },
        { text: '左上', origin: { x: 10, y: 10 } },
        { text: '右上', center: { x: 50, y: 10 } },
      ]),
    ).toBe('左上\n右上\n右下')
  })

  it('只有一部分有坐标时不重排', () => {
    expect(
      ocr.joinAnchors([
        { text: '先', origin: { x: 1, y: 9 } },
        { text: '后' },
      ]),
    ).toBe('先\n后')
  })
})

describe('端侧认字：够不够用', () => {
  it('标点不算，单独一个金额不够', () => {
    expect(ocr.meaningfulCount('¥ 35.00')).toBe(4)
    expect(ocr.usable('¥ 35.00')).toBe(false)
  })

  it('满 8 个字母、数字或汉字才算认全', () => {
    expect(ocr.MIN_MEANINGFUL).toBe(8)
    expect(ocr.usable('1234567')).toBe(false)
    expect(ocr.usable('12345678')).toBe(true)
    expect(ocr.usable('微信支付成功')).toBe(false)
    expect(ocr.usable('微信支付成功35元')).toBe(true)
  })

  it('节点测试环境没有微信，不能假装本机可用', () => {
    expect(ocr.supported()).toBe(false)
    expect(ocr.photoAvailable(false)).toBe(false)
    expect(ocr.photoAvailable(true)).toBe(true)
  })
})

describe('端侧认字：像素缓冲', () => {
  it('拷出长度刚好的 RGBA，不把 canvas 的原缓冲交出去', () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255])
    const buffer = ocr.rgbaBuffer(pixels, 1, 2)
    expect(buffer).not.toBe(pixels.buffer)
    expect(buffer && buffer.byteLength).toBe(8)
    expect(buffer && new Uint8Array(buffer)[0]).toBe(255)
  })

  it('长度对不上宽高时拒绝', () => {
    expect(ocr.rgbaBuffer(new Uint8Array(8), 2, 2)).toBeNull()
    expect(ocr.rgbaBuffer(null, 1, 1)).toBeNull()
  })
})
