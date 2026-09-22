<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api.ts'
import { formatYuan, yuanInputToCents } from '../money.ts'
import { occurredAtToDate, shanghaiDate } from '@server/time.ts'

const OCCASIONS = ['结婚', '满月', '搬家', '寿宴', '升学', '丧事', '过年', '其他']

type Contact = { id: string; name: string; relation: string; archived: boolean }
type Gift = {
  id: string
  contact_id: string
  kind: 'give' | 'receive'
  amount_cents: number
  occasion: string
  occurred_at: number
  note: string
}

const route = useRoute()
const router = useRouter()
const id = computed(() => (typeof route.params.id === 'string' ? route.params.id : null))
const kind = ref<'give' | 'receive'>('give')
const contactId = ref('')
const contacts = ref<Contact[]>([])
const amount = ref('')
const date = ref(shanghaiDate())
const occasion = ref('结婚')
const note = ref('')
const err = ref('')
const loading = ref(false)
const savedHint = ref('')

const options = computed(() => contacts.value.filter((c) => !c.archived || c.id === contactId.value))

function reset() {
  kind.value = 'give'
  amount.value = ''
  date.value = shanghaiDate()
  occasion.value = '结婚'
  note.value = ''
  err.value = ''
  savedHint.value = ''
}

async function load() {
  reset()
  contacts.value = (await api<{ items: Contact[] }>('/api/v1/contacts')).items
  const alive = options.value
  const preset = typeof route.query.contact === 'string' ? route.query.contact : ''
  contactId.value = (preset && alive.some((c) => c.id === preset) ? preset : alive[0]?.id) ?? ''
  if (!id.value) return
  const g = await api<Gift>(`/api/v1/gifts/${id.value}`)
  kind.value = g.kind
  contactId.value = g.contact_id
  amount.value = formatYuan(g.amount_cents)
  date.value = occurredAtToDate(g.occurred_at)
  occasion.value = g.occasion || '其他'
  note.value = g.note
}

function onPick(e: Event) {
  contactId.value = (e.target as HTMLSelectElement).value
}

async function save(again = false) {
  err.value = ''
  const cents = yuanInputToCents(amount.value)
  if (!cents) {
    err.value = '请输入正确金额'
    return
  }
  if (!contactId.value) {
    err.value = '请先添加联系人'
    return
  }
  loading.value = true
  try {
    const path = id.value ? `/api/v1/gifts/${id.value}` : '/api/v1/gifts'
    await api(path, {
      method: id.value ? 'PATCH' : 'POST',
      body: JSON.stringify({
        kind: kind.value,
        contact_id: contactId.value,
        amount_cents: cents,
        date: date.value,
        occasion: occasion.value,
        note: note.value,
      }),
    })
    if (again) {
      amount.value = ''
      note.value = ''
      savedHint.value = '已保存，继续记'
      return
    }
    router.replace('/favors')
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    loading.value = false
  }
}

async function remove() {
  if (!id.value || !confirm('删除这条人情记录？')) return
  await api(`/api/v1/gifts/${id.value}`, { method: 'DELETE' })
  router.replace('/favors')
}

watch(() => route.fullPath, load, { immediate: true })
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" @click="router.back()">‹</button>
      <h1>{{ id ? '改人情' : '记人情' }}</h1>
    </div>
    <div class="kind">
      <button class="expense" :class="{ on: kind === 'give' }" @click="kind = 'give'">送出</button>
      <button class="income" :class="{ on: kind === 'receive' }" @click="kind = 'receive'">收入</button>
    </div>
    <div class="card">
      <label class="field">
        <span>对方</span>
        <select v-if="options.length" :value="contactId" @change="onPick">
          <option v-for="c in options" :key="c.id" :value="c.id">
            {{ c.name }}{{ c.relation ? ` · ${c.relation}` : '' }}
          </option>
        </select>
        <p v-else class="muted" style="margin: 0">
          还没有联系人。
          <router-link to="/favors/people">去添加</router-link>
        </p>
      </label>
      <p v-if="options.length" class="muted" style="margin: -4px 0 12px">
        <router-link to="/favors/people">管理联系人</router-link>
      </p>
      <label class="field"><span>金额（元）</span><input v-model="amount" inputmode="decimal" placeholder="0.00" /></label>
      <label class="field"><span>日期</span><input v-model="date" type="date" /></label>
      <div class="field">
        <span>事由</span>
        <div class="chips">
          <button v-for="o in OCCASIONS" :key="o" class="chip" :class="{ on: occasion === o }" @click="occasion = o">
            {{ o }}
          </button>
        </div>
      </div>
      <label class="field"><span>备注</span><input v-model="note" maxlength="200" /></label>
      <p v-if="savedHint" class="muted">{{ savedHint }}</p>
      <p v-if="err" class="err">{{ err }}</p>
      <button class="btn" :disabled="loading || !contactId" @click="save(false)">保存</button>
      <button v-if="!id" class="btn ghost" style="margin-top: 8px" :disabled="loading || !contactId" @click="save(true)">再记一笔</button>
      <button v-if="id" class="btn ghost" style="margin-top: 8px" @click="remove">删除</button>
    </div>
  </div>
</template>
