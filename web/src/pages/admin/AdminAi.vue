<script setup lang="ts">
/**
 * AI 配置可以有多套，按从上到下的顺序接力：上一套失败才用下一套。
 * 不是多选一。api_key 只写不读，留空表示不改。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type AiItem = {
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

const PRESETS = [
  { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: 'Moonshot', base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
]

const items = ref<AiItem[]>([])
const err = ref('')
const msg = ref('')
const busy = ref(false)

function blank(): AiItem {
  return { id: '', name: '', enabled: true, base_url: '', model: '', api_key: '', key_hint: '', endpoint: '', clear_key: false }
}

async function load() {
  err.value = ''
  const data = await adminApi<{ items: Omit<AiItem, 'api_key' | 'clear_key'>[] }>('/api/v1/admin/ai')
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

function applyPreset(item: AiItem, event: Event) {
  const label = (event.target as HTMLSelectElement).value
  const preset = PRESETS.find((p) => p.label === label)
  if (!preset) return
  item.base_url = preset.base_url
  item.model = preset.model
  if (!item.name) item.name = preset.label
}

async function save() {
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    await adminApi('/api/v1/admin/ai', {
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
    msg.value = '已保存。解析和分类建议会按当前顺序失败换下一套。'
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}

async function test(item: AiItem) {
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    const res = await adminApi<{ ok: boolean; message?: string; latency_ms?: number; sample?: string }>(
      '/api/v1/admin/ai/test',
      {
        method: 'POST',
        body: JSON.stringify({
          id: item.id,
          name: item.name,
          base_url: item.base_url,
          model: item.model,
          api_key: item.api_key,
        }),
      },
    )
    if (res.ok) msg.value = `连通正常 · ${res.latency_ms}ms · ${res.sample ?? ''}`
    else err.value = `连通失败：${res.message ?? '未知错误'}`
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
    <h2>AI 解析配置</h2>
    <p class="muted" style="margin-top:0">
      可配置多套，按顺序接力，不是只启用其中一套。上一套超时、报错或返回无法解析时，自动换下一套。不配置也能导入，规则解析照常可用。
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
        <input v-model="item.name" placeholder="DeepSeek" />
      </div>
      <div class="field">
        <span>快速填充</span>
        <select @change="applyPreset(item, $event)">
          <option value="">选择常见服务（可选）</option>
          <option v-for="p in PRESETS" :key="p.label" :value="p.label">{{ p.label }}</option>
        </select>
      </div>
      <div class="field">
        <span>base_url</span>
        <input v-model="item.base_url" placeholder="https://api.deepseek.com/v1" />
      </div>
      <div class="field">
        <span>model</span>
        <input v-model="item.model" placeholder="deepseek-chat" />
      </div>
      <div class="field">
        <span>api_key{{ item.key_hint ? `（已保存：${item.key_hint}，留空不改）` : '' }}</span>
        <input v-model="item.api_key" type="password" autocomplete="off" :placeholder="item.key_hint ? '留空则不修改' : 'sk-...'" />
      </div>
      <p v-if="item.endpoint" class="muted">实际请求：{{ item.endpoint }}</p>
      <button class="btn ghost compact" type="button" :disabled="busy" @click="test(item)">测试这一套</button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="msg" class="muted">{{ msg }}</p>
    <div class="admin-actions">
      <button class="btn ghost" type="button" :disabled="busy || items.length >= 8" @click="add">添加一套</button>
      <button class="btn" type="button" :disabled="busy" @click="save">保存</button>
    </div>
  </div>
</template>
