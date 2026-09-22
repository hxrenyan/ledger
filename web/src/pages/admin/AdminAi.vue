<script setup lang="ts">
/**
 * 管理后台 · AI 配置。
 *
 * 全局单行配置，供账单导入时做格式兜底与分类建议。
 * api_key 只写不读：保存后接口仅回显掩码，留空表示保持原值。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type AiConfig = {
  enabled: boolean
  base_url: string
  model: string
  has_key: boolean
  key_hint: string
  endpoint: string
  updated_at: number
}

const PRESETS = [
  { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: 'Moonshot', base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
]

const enabled = ref(false)
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const keyHint = ref('')
const endpoint = ref('')
const err = ref('')
const msg = ref('')
const busy = ref(false)

async function load() {
  err.value = ''
  try {
    const cfg = await adminApi<AiConfig>('/api/v1/admin/ai')
    enabled.value = cfg.enabled
    baseUrl.value = cfg.base_url
    model.value = cfg.model
    keyHint.value = cfg.key_hint
    endpoint.value = cfg.endpoint
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  }
}

function applyPreset(e: Event) {
  const label = (e.target as HTMLSelectElement).value
  const preset = PRESETS.find((p) => p.label === label)
  if (!preset) return
  baseUrl.value = preset.base_url
  model.value = preset.model
}

async function save() {
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    await adminApi('/api/v1/admin/ai', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: enabled.value,
        base_url: baseUrl.value,
        model: model.value,
        api_key: apiKey.value,
      }),
    })
    apiKey.value = ''
    msg.value = '已保存'
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}

async function test() {
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    const res = await adminApi<{ ok: boolean; message?: string; latency_ms?: number; endpoint?: string; sample?: string }>(
      '/api/v1/admin/ai/test',
      { method: 'POST', body: JSON.stringify({ base_url: baseUrl.value, model: model.value, api_key: apiKey.value }) },
    )
    if (res.ok) msg.value = `连通正常 · ${res.latency_ms}ms · ${res.sample ?? ''}`
    else err.value = `连通失败：${res.message ?? '未知错误'}`
  } catch (e) {
    err.value = e instanceof Error ? e.message : '测试失败'
  } finally {
    busy.value = false
  }
}

async function clearKey() {
  if (!confirm('清空 API Key？清空后 AI 兜底解析与分类建议会不可用。')) return
  busy.value = true
  try {
    await adminApi('/api/v1/admin/ai', { method: 'PUT', body: JSON.stringify({ enabled: false, clear_key: true }) })
    msg.value = '已清空密钥'
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '操作失败'
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="card">
    <h2>AI 解析配置</h2>
    <p class="muted" style="margin-top:0">
      用于账单导入时的兜底解析与分类建议。不启用也能导入：微信 / 支付宝 / 银行 / 通用 CSV、Excel、JSON 都走规则解析。
    </p>

    <div class="field">
      <span>启用</span>
      <select v-model="enabled">
        <option :value="true">启用</option>
        <option :value="false">停用</option>
      </select>
    </div>

    <div class="field">
      <span>快速填充</span>
      <select @change="applyPreset">
        <option value="">选择常见服务（可选）</option>
        <option v-for="p in PRESETS" :key="p.label" :value="p.label">{{ p.label }}</option>
      </select>
    </div>

    <div class="field">
      <span>base_url（OpenAI 兼容，可带或不带 /v1）</span>
      <input v-model="baseUrl" placeholder="https://api.deepseek.com/v1" />
    </div>

    <div class="field">
      <span>model</span>
      <input v-model="model" placeholder="deepseek-chat" />
    </div>

    <div class="field">
      <span>api_key{{ keyHint ? `（已保存：${keyHint}，留空表示不改）` : '' }}</span>
      <input v-model="apiKey" type="password" :placeholder="keyHint ? '留空则不修改' : 'sk-...'" autocomplete="off" />
    </div>

    <p v-if="endpoint" class="muted" style="margin-top:-4px">实际请求地址：{{ endpoint }}</p>
    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="msg" class="muted">{{ msg }}</p>

    <div class="inline" style="margin-top:8px">
      <button class="btn" :disabled="busy" @click="save">保存</button>
      <button class="btn ghost" :disabled="busy" @click="test">测试连通</button>
      <button v-if="keyHint" class="btn danger" style="width:auto" :disabled="busy" @click="clearKey">清空密钥</button>
    </div>
  </div>
</template>
