<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type Account, type Category } from '../api.ts'
import { formatYuan, yuanInputToCents } from '../money.ts'

type Rec = {
  id: string
  kind: string
  amount_cents: number
  account_id: string
  category_id: string
  note: string
  day_of_month: number
  enabled: number
}

const router = useRouter()
const items = ref<Rec[]>([])
const accounts = ref<Account[]>([])
const cats = ref<Category[]>([])
const kind = ref<'expense' | 'income'>('expense')
const amount = ref('')
const day = ref(1)
const accountId = ref('')
const categoryId = ref('')
const note = ref('房租')
const err = ref('')

async function load() {
  const [r, a, c] = await Promise.all([
    api<{ items: Rec[] }>('/api/v1/recurrences'),
    api<{ items: Account[] }>('/api/v1/accounts'),
    api<{ items: Category[] }>('/api/v1/categories'),
  ])
  items.value = r.items
  accounts.value = a.items.filter((x) => !x.archived)
  cats.value = c.items.filter((x) => !x.archived)
  accountId.value = accounts.value[0]?.id ?? ''
  categoryId.value = cats.value.find((x) => x.kind === kind.value)?.id ?? ''
}

async function add() {
  err.value = ''
  const cents = yuanInputToCents(amount.value)
  if (!cents) {
    err.value = '请输入金额'
    return
  }
  try {
    await api('/api/v1/recurrences', {
      method: 'POST',
      body: JSON.stringify({
        kind: kind.value,
        amount_cents: cents,
        account_id: accountId.value,
        category_id: categoryId.value,
        day_of_month: Number(day.value),
        note: note.value,
      }),
    })
    amount.value = ''
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '失败'
  }
}

async function toggle(r: Rec) {
  await api(`/api/v1/recurrences/${r.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: !r.enabled }),
  })
  await load()
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" @click="router.push('/me')">‹</button>
      <h1>周期记账</h1>
    </div>
    <p class="muted">每月固定日自动记一笔（工资、房租）。打开明细时会补记到期项。</p>
    <div class="card" style="margin: 12px 0">
      <div class="kind">
        <button class="expense" :class="{ on: kind === 'expense' }" @click="kind = 'expense'">支出</button>
        <button class="income" :class="{ on: kind === 'income' }" @click="kind = 'income'">收入</button>
      </div>
      <div class="inline">
        <input v-model="amount" inputmode="decimal" placeholder="金额" />
        <input v-model.number="day" type="number" min="1" max="28" style="max-width: 64px" />
        <span class="muted">日</span>
      </div>
      <label class="field" style="margin-top: 8px">
        <span>账户</span>
        <select v-model="accountId">
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label class="field">
        <span>分类</span>
        <select v-model="categoryId">
          <option v-for="c in cats.filter(x => x.kind === kind)" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <label class="field"><span>备注</span><input v-model="note" /></label>
      <p v-if="err" class="err">{{ err }}</p>
      <button class="btn" @click="add">添加周期</button>
    </div>
    <div class="card">
      <div class="row" v-for="r in items" :key="r.id">
        <div>
          <div>{{ r.note || (r.kind === 'income' ? '收入' : '支出') }} · 每月 {{ r.day_of_month }} 日</div>
          <div class="muted">{{ formatYuan(r.amount_cents) }} {{ r.enabled ? '' : '已停' }}</div>
        </div>
        <button class="btn ghost" style="width: auto" @click="toggle(r)">{{ r.enabled ? '停用' : '启用' }}</button>
      </div>
    </div>
  </div>
</template>
