<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type Item = { id: string; title: string; body: string }
const items = ref<Item[]>([])
const err = ref('')
const message = ref('')
const busy = ref(false)
async function load() {
  try { const data = await adminApi<{ items: Item[] }>('/api/v1/admin/announcements'); items.value = data.items || []; err.value = '' }
  catch (e) { err.value = e instanceof Error ? e.message : '加载失败' }
}
function add() { if (items.value.length < 10) items.value.push({ id: crypto.randomUUID().replaceAll('-', '').slice(0, 24), title: '', body: '' }) }
function remove(index: number) { items.value.splice(index, 1) }
async function save() {
  if (busy.value) return
  busy.value = true; err.value = ''; message.value = ''
  try {
    const data = await adminApi<{ items: Item[] }>('/api/v1/admin/announcements', { method: 'PUT', body: JSON.stringify({ items: items.value }) })
    items.value = data.items; message.value = '公告已发布'
  } catch (e) { err.value = e instanceof Error ? e.message : '保存失败' }
  finally { busy.value = false }
}
onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div class="admin-config-page">
    <div class="admin-config-title"><div><h2>小程序公告</h2><p class="muted">公告显示在原生工具页，最多 10 条；删除后下次同步即下架。</p></div></div>
    <div v-for="(item, index) in items" :key="item.id" class="admin-config-block announcement-editor">
      <label>标题<input v-model="item.title" maxlength="40" placeholder="最多40字"></label>
      <label>内容<textarea v-model="item.body" maxlength="500" rows="3" placeholder="最多500字"></textarea></label>
      <button class="secondary" type="button" @click="remove(index)">移除</button>
    </div>
    <div class="admin-seg"><button type="button" :disabled="items.length >= 10" @click="add">添加公告</button><button type="button" :disabled="busy" @click="save">{{ busy ? '发布中…' : '发布公告' }}</button></div>
    <p v-if="err" class="err admin-alert">{{ err }}</p><p v-if="message" class="admin-success">{{ message }}</p>
  </div>
</template>

<style scoped>
.announcement-editor { display: grid; gap: 12px; }
.announcement-editor label { display: grid; gap: 6px; font-size: 13px; }
.announcement-editor input, .announcement-editor textarea { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--line, #d9dee7); border-radius: 4px; font: inherit; }
</style>
