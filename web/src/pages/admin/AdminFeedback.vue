<script setup lang="ts">
/**
 * 查看用户反馈，写回复，并标成已处理或重新打开。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type Status = 'open' | 'done' | 'all'
type Item = {
  id: number
  user_id: number
  username: string
  nickname: string
  content: string
  contact: string
  status: 'open' | 'done'
  status_label: string
  reply: string
  time: string
}

const status = ref<Status>('open')
const items = ref<Item[]>([])
const drafts = ref<Record<number, string>>({})
const err = ref('')
const msg = ref('')
const loading = ref(false)
const busyId = ref<number | ''>('')

const filters: { key: Status; label: string }[] = [
  { key: 'open', label: '待处理' },
  { key: 'done', label: '已处理' },
  { key: 'all', label: '全部' },
]

async function load() {
  loading.value = true
  err.value = ''
  try {
    const data = await adminApi<{ items: Item[] }>(`/api/v1/admin/feedbacks?status=${status.value}`)
    items.value = data.items
    const next: Record<number, string> = {}
    for (const item of data.items) next[item.id] = drafts.value[item.id] ?? item.reply
    drafts.value = next
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function save(item: Item, next: 'open' | 'done') {
  if (busyId.value) return
  busyId.value = item.id
  err.value = ''
  msg.value = ''
  try {
    await adminApi(`/api/v1/admin/feedbacks/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next, reply: drafts.value[item.id] ?? '' }),
    })
    msg.value = next === 'done' ? '已标成已处理' : '已重新打开'
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busyId.value = ''
  }
}

function pick(next: Status) {
  status.value = next
  load()
}

onMounted(load)
</script>

<template>
  <section class="admin-panel">
    <div class="admin-panel-head">
      <div>
        <h3>用户反馈</h3>
        <p class="muted">{{ loading ? '加载中' : `共 ${items.length} 条` }}</p>
      </div>
      <div class="feedback-filters">
        <button
          v-for="item in filters"
          :key="item.key"
          class="btn ghost compact"
          :class="{ on: status === item.key }"
          type="button"
          @click="pick(item.key)"
        >{{ item.label }}</button>
      </div>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="msg" class="muted">{{ msg }}</p>
    <div v-if="!items.length && !loading" class="admin-empty">没有反馈</div>
    <article v-for="item in items" :key="item.id" class="feedback-item">
      <div class="admin-list-row">
        <div class="admin-avatar">{{ (item.nickname || item.username || '?').slice(0, 1) }}</div>
        <div class="admin-row-main">
          <strong>{{ item.nickname || item.username || '已删除用户' }}</strong>
          <span>@{{ item.username || '—' }} · {{ item.time }}</span>
          <span v-if="item.contact">联系方式 {{ item.contact }}</span>
        </div>
        <span class="admin-status" :class="item.status === 'done' ? 'on' : 'off'">{{ item.status_label }}</span>
      </div>
      <p class="feedback-content">{{ item.content }}</p>
      <label class="field">
        <span>回复</span>
        <textarea class="feedback-reply" :value="drafts[item.id]" @input="drafts[item.id] = ($event.target as HTMLTextAreaElement).value" />
      </label>
      <button
        v-if="item.status === 'open'"
        class="btn compact"
        type="button"
        :disabled="busyId === item.id"
        @click="save(item, 'done')"
      >标记已处理</button>
      <button v-else class="btn ghost compact" type="button" :disabled="busyId === item.id" @click="save(item, 'open')">重新打开</button>
    </article>
  </section>
</template>

<style scoped>
.feedback-filters {
  display: flex;
  gap: 8px;
}
.feedback-filters .btn {
  width: auto;
}
.feedback-filters .on {
  background: #eef0ff;
  color: #3b5bdb;
}
.feedback-item {
  padding: 12px 0;
  border-top: 1px solid #ececef;
}
.feedback-content {
  margin: 8px 0 12px;
  white-space: pre-wrap;
}
.feedback-reply {
  width: 100%;
  height: 72px;
  min-height: 72px;
  box-sizing: border-box;
  resize: vertical;
}
.feedback-item .btn {
  width: auto;
}
</style>
