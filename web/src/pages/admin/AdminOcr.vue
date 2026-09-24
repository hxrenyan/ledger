<script setup lang="ts">
/**
 * 图片识别（拍照记账）可以配多套，按从上到下的顺序接力：上一套失败才用下一套。
 * 只保存接口配置。拍的图只在当次识别请求里过一遍，不落库、不进对象存储。
 *
 * 这一层只负责「把图上的字读出来」。读了字之后要变成流水，还得靠「AI 配置」里那套
 * 文本模型来整理 —— 两套都配上，拍照记账才能一路走到入账。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type OcrItem = {
  id: number | ''
  name: string
  enabled: boolean
  base_url: string
  model: string
  api_key: string
  key_hint: string
  endpoint: string
  clear_key: boolean
}

const SILICON = {
  base_url: 'https://api.siliconflow.cn/v1',
  model: 'PaddlePaddle/PaddleOCR-VL-1.5',
}

const items = ref<OcrItem[]>([])
const err = ref('')
const msg = ref('')
const busy = ref(false)

function blank(): OcrItem {
  return { id: '', name: '', enabled: true, base_url: SILICON.base_url, model: SILICON.model, api_key: '', key_hint: '', endpoint: '', clear_key: false }
}

async function load() {
  err.value = ''
  const data = await adminApi<{ items: Omit<OcrItem, 'api_key' | 'clear_key'>[] }>('/api/v1/admin/ocr')
  items.value = data.items.map((item) => ({ ...item, api_key: '', clear_key: false }))
}

function add() {
  items.value.push(blank())
}

function move(index: number, delta: number) {
  const next = index + delta
  if (next < 0 || next >= items.value.length) return
  const copy = items.value.slice()
  const [row] = copy.splice(index, 1)
  copy.splice(next, 0, row)
  items.value = copy
}

function remove(index: number) {
  items.value.splice(index, 1)
}

async function save() {
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    await adminApi('/api/v1/admin/ocr', {
      method: 'PUT',
      body: JSON.stringify({
        items: items.value.map((item) => ({
          id: item.id || undefined,
          name: item.name,
          enabled: item.enabled,
          base_url: item.base_url,
          model: item.model,
          api_key: item.api_key,
          clear_key: item.clear_key,
        })),
      }),
    })
    msg.value = '已保存。识别时按当前顺序接力，图片不会保存。'
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}

async function test(item: OcrItem, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    const fd = new FormData()
    fd.append('file', file)
    if (item.id) fd.append('id', String(item.id))
    fd.append('name', item.name)
    fd.append('base_url', item.base_url)
    fd.append('model', item.model)
    if (item.api_key) fd.append('api_key', item.api_key)
    const res = await adminApi<{ ok: boolean; text?: string; chars?: number; latency_ms?: number; message?: string }>(
      '/api/v1/admin/ocr/test',
      { method: 'POST', body: fd },
    )
    if (res.ok) msg.value = `识别成功：${res.chars ?? 0} 字，用时 ${res.latency_ms ?? 0}ms\n\n${res.text ?? ''}`
    else err.value = res.message ?? '测试失败'
  } catch (e) {
    err.value = e instanceof Error ? e.message : '测试失败'
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  load().catch((e) => {
    err.value = e instanceof Error ? e.message : '加载失败'
  })
})
</script>

<template>
  <div class="card">
    <h2>图片识别</h2>
    <p class="muted" style="margin-top:0">
      拍照记账的第一步。可配置多套，按顺序接力，上一套超时或失败才换下一套。协议是 OpenAI 兼容的
      <code>/chat/completions</code>，图片以 data URL 放进 <code>image_url</code>（硅基流动的 PaddleOCR-VL 走这条）。
      <br />
      注意：这一步只把图上的字读出来。要变成可入账的流水，还要在「AI 配置」里配一套文本模型做整理；两套都配上，
      拍照才能一路走到记账。图片只在当次请求里识别，不保存。
    </p>
    <div v-for="(item, index) in items" :key="item.id || index" class="card" style="margin-bottom:12px">
      <div class="row">
        <strong>第 {{ index + 1 }} 套</strong>
        <div class="inline">
          <button class="btn ghost compact" type="button" :disabled="index === 0" @click="move(index, -1)">上移</button>
          <button class="btn ghost compact" type="button" :disabled="index === items.length - 1" @click="move(index, 1)">下移</button>
          <button class="btn danger compact" type="button" @click="remove(index)">删除</button>
        </div>
      </div>
      <div class="field">
        <span>参与接力</span>
        <select v-model="item.enabled">
          <option :value="true">是</option>
          <option :value="false">否</option>
        </select>
      </div>
      <div class="field">
        <span>名称</span>
        <input v-model="item.name" placeholder="硅基流动" />
      </div>
      <div class="field">
        <span>base_url</span>
        <input v-model="item.base_url" placeholder="https://api.siliconflow.cn/v1" />
      </div>
      <div class="field">
        <span>model</span>
        <input v-model="item.model" placeholder="PaddlePaddle/PaddleOCR-VL-1.5" />
      </div>
      <div class="field">
        <span>api_key{{ item.key_hint ? `（已保存：${item.key_hint}，留空不改）` : '' }}</span>
        <input v-model="item.api_key" type="password" autocomplete="off" :placeholder="item.key_hint ? '留空则不修改' : 'sk-...'" />
      </div>
      <p v-if="item.endpoint" class="muted">实际请求：{{ item.endpoint }}</p>
      <label class="btn ghost compact">
        用一张图测试这一套
        <input type="file" accept="image/*" hidden @change="test(item, $event)" />
      </label>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <pre v-if="msg" class="muted" style="white-space:pre-wrap">{{ msg }}</pre>
    <div class="admin-actions">
      <button class="btn ghost" type="button" :disabled="busy || items.length >= 8" @click="add">添加一套</button>
      <button class="btn" type="button" :disabled="busy" @click="save">保存</button>
    </div>
  </div>
</template>
