<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type PageConfig = { mode: 'native' | 'webview'; path: string }
type Config = { enabled: boolean; host: string; pages: Record<string, PageConfig> }
const labels: Record<string, string> = { budgets: '预算', categories: '分类', recurring: '周期记账', import: '导入', ledger: '账本' }
const config = ref<Config>({ enabled: false, host: '', pages: {} })
const nativeOnly = ref<string[]>([])
const err = ref('')
const msg = ref('')
const busy = ref(false)
async function load() {
  const data = await adminApi<{ webview: Config; native_only: string[] }>('/api/v1/admin/app-config')
  config.value = data.webview; nativeOnly.value = data.native_only
}
async function save() {
  err.value = ''; msg.value = ''
  if (config.value.enabled && !/^https:\/\/[^\s/]+$/.test(config.value.host.trim().replace(/\/+$/, ''))) { err.value = '启用前请填写 https:// 开头且不带路径的域名'; return }
  busy.value = true
  try {
    const data = await adminApi<{ webview: Config }>('/api/v1/admin/app-config', { method: 'PUT', body: JSON.stringify({ 'webview.host': config.value.host, 'webview.enabled': config.value.enabled, 'webview.pages': config.value.pages }) })
    config.value = data.webview; msg.value = '产品配置已保存。'
  } catch (e) { err.value = e instanceof Error ? e.message : '保存失败' } finally { busy.value = false }
}
function name(key: string) { return labels[key] ?? key }
onMounted(() => load().catch((e) => { err.value = e instanceof Error ? e.message : '加载失败' }))
</script>

<template>
  <div class="admin-config-page">
    <div class="admin-config-title"><div><h2>Web-view 配置</h2><p class="muted">将长尾功能逐页切换到网页端，原生专属页面始终保持原生。</p></div><span class="admin-status" :class="config.enabled ? 'on' : 'off'">{{ config.enabled ? '已启用' : '未启用' }}</span></div>
    <div class="admin-config-block"><div class="admin-block-heading"><div><h3>基础设置</h3><p class="muted">网页端需要部署在 HTTPS 域名下。</p></div><label class="admin-switch"><input v-model="config.enabled" type="checkbox" /><span></span></label></div><label class="field"><span>Web-view 域名</span><input v-model="config.host" placeholder="https://ledger.example.com" /></label><p class="admin-hint">只填写域名，不要带路径或末尾斜杠。</p></div>
    <div class="admin-config-block"><div class="admin-block-heading"><div><h3>页面归属</h3><p class="muted">先保持原生，确认网页端稳定后再逐页灰度。</p></div></div><div v-for="(page, key) in config.pages" :key="key" class="admin-page-row"><div><strong>{{ name(key) }}</strong><span>{{ page.path }}</span></div><select v-model="page.mode" :disabled="nativeOnly.includes(key)"><option value="native">原生页面</option><option value="webview">Web-view</option></select></div></div>
    <p v-if="err" class="err admin-alert">{{ err }}</p><p v-if="msg" class="admin-success">{{ msg }}</p>
    <div class="admin-savebar"><span class="muted">修改后点击保存才会生效</span><button class="btn" type="button" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存产品配置' }}</button></div>
  </div>
</template>
