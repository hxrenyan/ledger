<script setup lang="ts">
/**
 * 语音识别可以配多套，按从上到下的顺序接力：上一套失败才用下一套。
 * 这里只保存接口配置。测试音频和用户录音都不落库。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type AsrItem = {
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
  model: 'XingChenAGI/XingChenASR-V3.2-Ultra',
}

const items = ref<AsrItem[]>([])
const err = ref('')
const msg = ref('')
const busy = ref(false)

function blank(): AsrItem {
  return { id: '', name: '', enabled: true, base_url: SILICON.base_url, model: SILICON.model, api_key: '', key_hint: '', endpoint: '', clear_key: false }
}

async function load() {
  err.value = ''
  try {
    const data = await adminApi<{ items: Omit<AsrItem, 'api_key' | 'clear_key'>[] }>('/api/v1/admin/asr')
    items.value = data.items.map((item) => ({ ...item, api_key: '', clear_key: false }))
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  }
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
    await adminApi('/api/v1/admin/asr', {
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
    msg.value = '已保存。识别时按当前顺序接力，录音不会保存。'
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}

/** 点按钮再打开文件框。input 设了 display:none 时，包在 label 里点文字经常弹不出选择框。 */
function openFile(event: Event) {
  const button = event.currentTarget
  if (!(button instanceof HTMLButtonElement)) return
  const input = button.nextElementSibling
  if (input instanceof HTMLInputElement) input.click()
}

async function test(item: AsrItem, event: Event) {
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
    const res = await adminApi<{ ok: boolean; text?: string; message?: string }>('/api/v1/admin/asr/test', {
      method: 'POST',
      body: fd,
    })
    if (res.ok) msg.value = `识别结果：${res.text ?? ''}`
    else err.value = res.message ?? '测试失败'
  } catch (e) {
    err.value = e instanceof Error ? e.message : '测试失败'
  } finally {
    busy.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div class="admin-config-page">
    <div class="admin-config-title"><div><h2>语音识别</h2>
    <p class="muted">
      可配置多套，按顺序接力，不是只启用其中一套。上一套超时或失败才换下一套。协议目前是 OpenAI 兼容的
      <code>/audio/transcriptions</code>（硅基流动 XingChenASR 走这条）。录音只在当次请求里转写，不保存。
    </p></div></div>
    <div v-if="!items.length" class="admin-config-block admin-empty">暂未配置语音识别服务，点击下方「添加一套」开始配置。</div>
    <div v-for="(item, index) in items" :key="item.id || index" class="admin-config-block">
      <div class="admin-block-heading">
        <div class="admin-block-title">
          <span class="admin-step-badge">#{{ index + 1 }}</span>
          <strong>{{ item.name || `第 ${index + 1} 套配置` }}</strong>
          <span class="admin-status" :class="item.enabled ? 'on' : 'off'">{{ item.enabled ? '参与接力' : '已暂停' }}</span>
        </div>
        <div class="admin-actions-inline">
          <button class="admin-row-btn" type="button" :disabled="index === 0" @click="move(index, -1)">上移</button>
          <button class="admin-row-btn" type="button" :disabled="index === items.length - 1" @click="move(index, 1)">下移</button>
          <button class="admin-row-btn danger" type="button" @click="remove(index)">删除</button>
        </div>
      </div>
      <div class="admin-fields">
        <label class="field">
          <span>名称</span>
          <input v-model="item.name" placeholder="硅基流动" />
        </label>
        <div class="field admin-switch-field">
          <span>参与接力</span>
          <label class="admin-switch"><input v-model="item.enabled" type="checkbox" aria-label="参与接力" /><span></span></label>
        </div>
        <label class="field span-2">
          <span>base_url</span>
          <input v-model="item.base_url" placeholder="https://api.siliconflow.cn/v1" />
        </label>
        <label class="field span-2">
          <span>model</span>
          <input v-model="item.model" placeholder="XingChenAGI/XingChenASR-V3.2-Ultra" />
        </label>
        <label class="field span-2">
          <span>api_key{{ item.key_hint ? `（已保存：${item.key_hint}，留空不改）` : '' }}</span>
          <input v-model="item.api_key" type="password" autocomplete="off" :placeholder="item.key_hint ? '留空则不修改' : 'sk-...'" />
        </label>
      </div>
      <div class="admin-card-foot">
        <p class="admin-endpoint">{{ item.endpoint ? `实际请求：${item.endpoint}` : '填写 base_url 后自动拼接请求地址' }}</p>
        <div class="admin-card-actions">
          <button class="btn ghost compact" type="button" :disabled="busy" @click="openFile">用音频测试这一套</button>
          <input class="file-hidden" type="file" accept="audio/*,video/webm" @change="test(item, $event)" />
        </div>
      </div>
    </div>
    <p v-if="err" class="err admin-alert">{{ err }}</p>
    <p v-if="msg" class="admin-success">{{ msg }}</p>
    <div class="admin-savebar">
      <span class="muted">录音仅用于本次测试，不会保存</span>
      <div class="admin-actions-inline">
        <button class="btn ghost" type="button" :disabled="busy || items.length >= 8" @click="add">添加一套</button>
        <button class="btn" type="button" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>
