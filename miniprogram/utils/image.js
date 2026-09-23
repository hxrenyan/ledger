/**
 * 拍照 / 选图 → 压到能送出去的体积 → 交给 request.scanImage 去认。
 *
 * 为什么单独一个模块，而不是写在浮层里：
 *   1. 「压到多少」跟着传输通道变（云通道的 event 只有约 1MB，直连宽松得多），
 *      这个判断不该散在 UI 里 —— 见 request.imageLimit()；
 *   2. 压缩一次往往到不了底：估算公式只够定起点，真收敛靠逐档压完再核对体积。
 *      所以决策部分（起始档位）做成纯函数，真机行为由 prepare() 逐档逼出来。
 *   3. 只在这里调 wx.chooseMedia / wx.compressImage，别的页别自己调 ——
 *      check.mjs 会拦（绕开这里就等于绕开了体积守卫，症状是「体验版拍照必失败」）。
 *
 * 图片不留存：识别完就丢，临时文件交给微信自己回收，不落库、不进云存储。
 */

const request = require('./request')

/**
 * 压缩梯度：先降质量，再降分辨率。
 *
 * 顺序不能反 —— 小票上真正要紧的是数字，先缩图会先把它糊掉。
 * 质量降到底还在阈值外，才动分辨率。
 */
const STEPS = [
  { quality: 82, scale: 1 },
  { quality: 70, scale: 1 },
  { quality: 62, scale: 0.75 },
  { quality: 50, scale: 0.55 },
]

const BASE_QUALITY = STEPS[0].quality

/**
 * 粗略估算压缩后的字节数。**只用来决定从哪一档开始试**，不作为结论：
 * JPEG 的实际压缩率跟画面内容强相关（一大片白底的小票能压到 1/10，
 * 而手机拍的复杂场景可能只压到 1/2），估得准反而会让代码误以为能一次到位。
 */
function estimate(size, step) {
  const n = Number(size) || 0
  if (n <= 0) return 0
  const byQuality = Math.pow(step.quality / BASE_QUALITY, 1.4)
  return Math.round(n * byQuality * step.scale * step.scale)
}

/**
 * 起始档位下标：第一个估算能落进 limit 的档，再往前让一档起试。
 *
 * 为什么要让一档：估算按「画面复杂」的最坏情况算，偏保守；而多压一轮只多花
 * 一两百毫秒，压过头却是永久损失清晰度（小票上的数字就糊了）。宁可多试一次。
 * 让到 0 就是从头试。
 *
 * 体积未知时从 0 开始（只能盲压一次，见 prepare 的兜底）。
 * 体积已达标时也让到 0（也就是只压一次）—— 顺带把 png / heic 统一成 jpg，
 * 模型那边对格式更稳，而且这一步通常还能再省一半体积。
 */
function startStep(size, limit) {
  if (!(limit > 0)) return 0
  for (let i = 0; i < STEPS.length; i += 1) {
    if (estimate(size, STEPS[i]) <= limit) return Math.max(0, i - 1)
  }
  return STEPS.length - 1
}

/** 从某档开始的完整尝试序列。下标越界（负数或超出末尾）时回落到从头开始。 */
function stepsFrom(index) {
  const ok = index >= 0 && index <= STEPS.length
  return STEPS.slice(ok ? index : 0)
}

/** 用户在选图面板点了取消 —— 调用方要静默处理，别弹「失败」。 */
function cancelled() {
  return { code: 'cancelled', message: '', status: 0 }
}

function pick() {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      // 相机与相册都给：截图走相册，小票走相机。
      sourceType: ['camera', 'album'],
      // 让微信先粗压一道（主要是把相机直出的大图压下来），我们随后再精压。
      sizeType: ['compressed'],
      camera: 'back',
      success(res) {
        const f = (res && res.tempFiles && res.tempFiles[0]) || null
        if (!f || !f.tempFilePath) {
          reject(cancelled())
          return
        }
        resolve({
          filePath: f.tempFilePath,
          size: Number(f.size) || 0,
          width: Number(f.width) || 0,
        })
      },
      fail() {
        reject(cancelled())
      },
    })
  })
}

function statSize(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().stat({
      path: filePath,
      success(res) {
        resolve((res && res.stats && Number(res.stats.size)) || 0)
      },
      fail() {
        resolve(0)
      },
    })
  })
}

/** 读整个文件（压缩后已经很小了）。只为看文件头，见 detectMime。 */
function readAll(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      success(res) {
        resolve(res && res.data ? new Uint8Array(res.data) : new Uint8Array(0))
      },
      fail() {
        resolve(new Uint8Array(0))
      },
    })
  })
}

/**
 * 按文件头猜真实类型。
 *
 * 不能信扩展名：compressImage 的输出格式随机型变化（iOS 上 png 常常原样返回），
 * 而 multipart 分片的 Content-Type 与 JSON 里的 mime 都是我们自己写死的 ——
 * 写错会让模型收到与内容不符的 data URL。猜不出就按 jpeg 报（相机直出就是它）。
 */
function mimeOf(bytes) {
  if (bytes.length >= 8) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return 'image/webp'
    }
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return 'image/jpeg'
}

function compress(filePath, step, width) {
  return new Promise((resolve, reject) => {
    const opts = { src: filePath, quality: step.quality }
    // compressedWidth 是「宽」，高会按比例跟着走；只有要降分辨率时才传。
    if (step.scale < 1 && width > 0) {
      opts.compressedWidth = Math.max(1, Math.round(width * step.scale))
    }
    wx.compressImage({
      src: opts.src,
      quality: opts.quality,
      compressedWidth: opts.compressedWidth,
      success(res) {
        resolve((res && res.tempFilePath) || '')
      },
      fail(err) {
        reject({ code: 'compress', message: '图片处理失败，请重试', status: 0, detail: err })
      },
    })
  })
}

/**
 * 把选中的照片压到 limit 以内。
 * @param {{filePath:string, size?:number, width?:number}} picked pick() 的返回值
 * @param {number} [limit] 目标字节数，默认按当前传输通道取（request.imageLimit()）
 * @returns {Promise<{filePath:string, size:number, mime:string}>}
 */
async function prepare(picked, limit) {
  const budget = Number(limit) > 0 ? Number(limit) : request.imageLimit()
  let current = { filePath: picked.filePath, size: Number(picked.size) || 0 }
  const steps = stepsFrom(startStep(current.size, budget))

  for (let i = 0; i < steps.length; i += 1) {
    const next = await compress(current.filePath, steps[i], Number(picked.width) || 0)
    const path = next || current.filePath
    let size = await statSize(path)
    // stat 失败（个别机型 / 基础库）拿不到体积：只能收下这一档，再压也没依据。
    if (!size) {
      current = { filePath: path, size: 0 }
      break
    }
    current = { filePath: path, size: size }
    if (size <= budget) break
  }

  if (current.size > budget) {
    throw { code: 'too_large', message: '照片还是太大，靠近票据再拍一张' }
  }

  const bytes = await readAll(current.filePath)
  return { filePath: current.filePath, size: current.size, mime: mimeOf(bytes) }
}

module.exports = {
  STEPS,
  estimate,
  startStep,
  stepsFrom,
  mimeOf,
  pick,
  prepare,
}
