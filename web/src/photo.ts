/**
 * H5 版的「拍照 / 选图 → 压到能送出去的体积」：canvas 重绘那一半。
 *
 * 与 miniprogram/utils/image.js **同构**：同一份压缩梯度、同一个起始档位算法、
 * 同一条「先降质量、再降分辨率」的取舍。差别只在底层 API —— 小程序交给
 * wx.compressImage，H5 只能自己 canvas 重绘。
 * 决策部分（压几档、从哪档开始）在 ./photoSteps.ts，单独放是为了可单测。
 *
 * 为什么非要压：后端 /api/v1/ocr/scan 的上限是 6MB（src/routes/ocr.ts 的
 * MAX_IMAGE_BYTES），而手机直出的照片常常 3–8MB。不压就是「手机上拍一张必失败」。
 *
 * 图片不留存：识别完就丢，blob 交给 GC，不落库、不进任何存储。
 */

import { PHOTO_LIMIT, stepsFrom, startStep, type Step } from './photoSteps.ts'

export class PhotoError extends Error {
  code: string
  constructor(message: string, code = 'photo') {
    super(message)
    this.name = 'PhotoError'
    this.code = code
  }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const finish = (fn: () => void) => {
      URL.revokeObjectURL(url)
      fn()
    }
    const img = new Image()
    img.onload = () => finish(() => resolve(img))
    // 解不开通常是 HEIC 遇到不支持的浏览器，说清楚比抛原始错误好。
    img.onerror = () => finish(() => reject(new PhotoError('这张图打不开，换一张试试', 'decode')))
    img.src = url
  })
}

function drawStep(img: HTMLImageElement, step: Step): Promise<Blob | null> {
  const srcW = img.naturalWidth || img.width
  const srcH = img.naturalHeight || img.height
  const w = Math.max(1, Math.round(srcW * step.scale))
  const h = Math.max(1, Math.round(srcH * step.scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)

  // 先铺白底：截图多半是 png，透明区转成 jpeg 会变黑，正好糊掉小票上的字。
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', step.quality)
  })
}

export type Prepared = { blob: Blob; name: string; mime: string; size: number }

/**
 * 把用户选的照片压到 limit 以内。
 *
 * 与小程序那份的差别之一：这里**总是**过一遍 canvas，输出固定是 jpeg。
 * 所以不像 wx.compressImage 那样要按文件头猜 mime —— 类型是我们自己定的。
 */
export async function prepare(file: File, limit = PHOTO_LIMIT): Promise<Prepared> {
  const budget = limit > 0 ? limit : PHOTO_LIMIT
  const img = await loadImage(file)
  const steps = stepsFrom(startStep(file.size, budget))
  let best: Blob | null = null

  for (const step of steps) {
    const blob = await drawStep(img, step)
    if (!blob || !blob.size) continue
    best = blob
    if (blob.size <= budget) break
  }

  if (!best) throw new PhotoError('图片处理失败，请重试', 'compress')
  if (best.size > budget) throw new PhotoError('照片还是太大，靠近票据再拍一张', 'too_large')
  return { blob: best, name: 'photo.jpg', mime: 'image/jpeg', size: best.size }
}
