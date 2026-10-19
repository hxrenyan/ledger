<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { centsToYuan } from '@server/money.ts'
import { occurredAtToDate, shanghaiDate } from '@server/time.ts'
import { api } from '../../tools/session.ts'

type Gift = {
  id: number
  contact_id: number
  kind: 'give' | 'receive'
  amount_cents: number
  occasion: string
  occurred_at: number
  note: string
}

type Contact = {
  id: number
  name: string
  relation: string
}

const route = useRoute()
const router = useRouter()
const contactId = computed(() => String(route.params.contactId || ''))
const contact = ref<Contact | null>(null)
const items = ref<Gift[]>([])
const error = ref('')
const loading = ref(true)
const busyId = ref<number | null>(null)

const given = computed(() => items.value.filter((item) => item.kind === 'give').reduce((sum, item) => sum + item.amount_cents, 0))
const received = computed(() => items.value.filter((item) => item.kind === 'receive').reduce((sum, item) => sum + item.amount_cents, 0))
const net = computed(() => received.value - given.value)

const hint = computed(() => {
  if (!given.value && !received.value) return '还没有往来记录'
  if (received.value > given.value) return `收到的比送出的多 ${centsToYuan(received.value - given.value)}，下次记得还上`
  if (given.value > received.value) return `送出的比收到的多 ${centsToYuan(given.value - received.value)}`
  return '两边刚好持平'
})

const title = computed(() => contact.value?.name || (items.value.length ? '往来' : '这位联系人'))

onMounted(load)

async function load() {
  if (!contactId.value) return
  loading.value = true
  error.value = ''
  try {
    const [gifts, contacts] = await Promise.all([
      api<{ items: Gift[] }>(`/api/v1/gifts?contact_id=${encodeURIComponent(contactId.value)}`),
      api<{ items: Contact[] }>('/api/v1/contacts'),
    ])
    items.value = gifts.items || []
    contact.value = (contacts.items || []).find((item) => String(item.id) === contactId.value) || null
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function dayLabel(ms: number) {
  const date = occurredAtToDate(ms)
  const [year, month, day] = date.split('-')
  if (year !== shanghaiDate().slice(0, 4)) return `${year}年${Number(month)}月${Number(day)}日`
  return `${Number(month)}月${Number(day)}日`
}

async function remove(item: Gift) {
  if (busyId.value != null) return
  if (!window.confirm('删掉这条记录？')) return
  busyId.value = item.id
  error.value = ''
  try {
    await api(`/api/v1/gifts/${item.id}`, { method: 'DELETE' })
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除失败'
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="tools-head">
    <button class="btn ghost compact" type="button" @click="router.push('/tools/contacts')">‹ 联系人</button>
    <h1>{{ title }}</h1>
    <button
      v-if="contact"
      class="btn ghost compact"
      type="button"
      @click="router.push('/tools/contacts/' + contactId)"
    >
      编辑
    </button>
  </div>

  <p v-if="contact?.relation" class="muted relation">{{ contact.relation }}</p>
  <p v-if="error" class="err">{{ error }}</p>
  <p v-if="loading" class="muted">加载中…</p>

  <template v-else>
    <div class="summary">
      <div class="card stat">
        <span>送出</span>
        <strong class="expense">{{ centsToYuan(given) }}</strong>
      </div>
      <div class="card stat">
        <span>收到</span>
        <strong class="income">{{ centsToYuan(received) }}</strong>
      </div>
    </div>

    <div class="card net">
      <div class="net-row">
        <span>差额</span>
        <strong :class="net >= 0 ? 'income' : 'expense'">{{ centsToYuan(net) }}</strong>
      </div>
      <p class="muted">{{ hint }}</p>
    </div>

    <div class="card">
      <h2>往来记录</h2>
      <p v-if="!items.length" class="muted">还没有往来记录</p>
      <div v-for="item in items" :key="item.id" class="gift">
        <button type="button" class="gift-main" @click="router.push('/tools/gifts/' + item.id)">
          <span>
            <strong>{{ item.occasion || '未写事由' }}</strong>
            <span class="muted line">
              {{ dayLabel(item.occurred_at) }} · {{ item.kind === 'give' ? '送出' : '收入' }}
              <template v-if="item.note"> · {{ item.note }}</template>
            </span>
          </span>
          <strong :class="item.kind === 'give' ? 'expense' : 'income'">
            {{ item.kind === 'give' ? '-' : '+' }}{{ centsToYuan(item.amount_cents) }}
          </strong>
        </button>
        <button type="button" class="link danger" :disabled="busyId === item.id" @click="remove(item)">删</button>
      </div>
    </div>

    <button class="btn" type="button" @click="router.push('/tools/contacts/' + contactId + '/gifts/new')">
      给 {{ title }} 记一笔
    </button>
  </template>
</template>

<style scoped>
.tools-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.tools-head h1 {
  margin: 0;
  flex: 1;
  font-size: 20px;
  text-align: center;
}
.tools-head .btn { width: auto; min-height: 36px; padding: 6px 12px; }
.relation { margin: 0 0 12px; }
.summary { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.stat { text-align: center; }
.stat span { display: block; color: var(--muted); font-size: 12px; }
.stat strong { display: block; margin-top: 4px; font-size: 20px; }
.net-row { display: flex; justify-content: space-between; align-items: center; }
.net p { margin: 8px 0 0; }
h2 { margin: 0 0 8px; font-size: 16px; }
.gift { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--line); }
.gift-main {
  flex: 1;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  border: 0;
  background: transparent;
  text-align: left;
  padding: 12px 0;
}
.line { display: block; margin-top: 4px; }
.link {
  border: 0;
  background: transparent;
  color: var(--brand);
  padding: 8px;
}
.link.danger { color: var(--expense); }
</style>
