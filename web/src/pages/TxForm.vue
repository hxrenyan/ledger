<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import LedgerName from '../components/LedgerName.vue'
import { api, type Account, type Category, type Tx } from '../api.ts'
import { formatYuan, yuanInputToCents } from '../money.ts'
import { loadPrefs, savePrefs } from '../prefs.ts'
import { useSession } from '../stores/session.ts'
import { addDays, occurredAtToDate, shanghaiDate } from '@server/time.ts'

const session = useSession()

const route = useRoute()
const router = useRouter()
const id = computed(() => (route.params.id as string | undefined) ?? null)
const kind = ref<'expense' | 'income' | 'transfer'>('expense')
const amount = ref('')
const date = ref(shanghaiDate())
const note = ref('')
const accountId = ref('')
const toAccountId = ref('')
const categoryId = ref('')
const accounts = ref<Account[]>([])
const categories = ref<Category[]>([])
const hasReceipt = ref(false)
const file = ref<File | null>(null)
const excluded = ref(false)
const err = ref('')
const loading = ref(false)
const savedHint = ref('')
const amountEl = ref<HTMLInputElement | null>(null)
const originalCents = ref(0)
const monthStats = ref<{
  expense_cents: number
  budget_cents: number
  by_category: { category_id: string; name: string; amount_cents: number; budget_cents: number }[]
} | null>(null)
const today = shanghaiDate()
const yesterday = addDays(today, -1)

const visibleCats = computed(() =>
  categories.value.filter((c) => c.kind === kind.value && !c.archived),
)

const amountPreview = computed(() => {
  if (!/[+\-*/＋－×÷]/.test(amount.value)) return ''
  const c = yuanInputToCents(amount.value)
  return c ? formatYuan(c) : ''
})

const budgetState = computed(() => {
  if (kind.value !== 'expense' || excluded.value || !monthStats.value) return { text: '', over: false }
  const cents = yuanInputToCents(amount.value) ?? 0
  const cat = monthStats.value.by_category.find((c) => c.category_id === categoryId.value)
  const catBudget = cat?.budget_cents ?? 0
  const catSpent = (cat?.amount_cents ?? 0) - originalCents.value
  if (catBudget > 0) {
    const after = catSpent + cents
    const name = cat?.name ?? '分类'
    if (after > catBudget) return { text: `本月${name}将超支 ${formatYuan(after - catBudget)}`, over: true }
    return { text: `本月${name}还剩 ${formatYuan(catBudget - after)}`, over: false }
  }
  const monthBudget = monthStats.value.budget_cents
  if (monthBudget > 0) {
    const after = monthStats.value.expense_cents - originalCents.value + cents
    if (after > monthBudget) return { text: `本月预算将超支 ${formatYuan(after - monthBudget)}`, over: true }
    return { text: `本月预算还剩 ${formatYuan(monthBudget - after)}`, over: false }
  }
  return { text: '', over: false }
})

async function load() {
  kind.value = 'expense'
  amount.value = ''
  date.value = shanghaiDate()
  note.value = ''
  file.value = null
  hasReceipt.value = false
  err.value = ''
  const [acc, cat] = await Promise.all([
    api<{ items: Account[] }>('/api/v1/accounts'),
    api<{ items: Category[] }>('/api/v1/categories'),
  ])
  accounts.value = acc.items.filter((a) => !a.archived)
  categories.value = cat.items
  const prefs = loadPrefs(session.ledgerId)
  accountId.value = (prefs.accountId && accounts.value.some((a) => a.id === prefs.accountId) ? prefs.accountId : accounts.value[0]?.id) ?? ''
  toAccountId.value = accounts.value.find((a) => a.id !== accountId.value)?.id ?? accounts.value[0]?.id ?? ''
  excluded.value = false
  savedHint.value = ''
  originalCents.value = 0
  if (id.value) {
    const tx = await api<Tx>(`/api/v1/transactions/${id.value}`)
    kind.value = tx.kind
    amount.value = formatYuan(tx.amount_cents)
    date.value = occurredAtToDate(tx.occurred_at)
    note.value = tx.note
    accountId.value = tx.account_id
    toAccountId.value = tx.to_account_id ?? toAccountId.value
    categoryId.value = tx.category_id ?? ''
    hasReceipt.value = tx.has_receipt
    excluded.value = !!tx.excluded
    originalCents.value = tx.kind === 'expense' && !tx.excluded ? tx.amount_cents : 0
  } else {
    const prefs = loadPrefs(session.ledgerId)
    // 新建流水固定从「支出」开始（见函数开头的 kind.value = 'expense'），
    // 因此只用支出默认分类。历史遗留的 income 分支在此不可达（vue-tsc 的 TS2367 告警即指向它），
    // 保留行为不变，是否修复由用户决定。
    const prefer = prefs.expenseCat
    categoryId.value = (prefer && visibleCats.value.some((c) => c.id === prefer) ? prefer : visibleCats.value[0]?.id) ?? ''
    await nextTick()
    amountEl.value?.focus()
  }
  await loadStats()
}

async function loadStats() {
  if (kind.value !== 'expense') {
    monthStats.value = null
    return
  }
  try {
    monthStats.value = await api(`/api/v1/stats/monthly?month=${date.value.slice(0, 7)}`)
  } catch {
    monthStats.value = null
  }
}

async function save(again = false) {
  err.value = ''
  const cents = yuanInputToCents(amount.value)
  if (!cents) {
    err.value = '请输入正确金额'
    return
  }
  if (kind.value !== 'transfer' && !categoryId.value) {
    err.value = '请选择分类'
    return
  }
  if (budgetState.value.over && !confirm(`${budgetState.value.text}，仍要保存？`)) return
  loading.value = true
  try {
    const path = id.value ? `/api/v1/transactions/${id.value}` : '/api/v1/transactions'
    const saved = await api<Tx>(path, {
      method: id.value ? 'PATCH' : 'POST',
      body: JSON.stringify({
        kind: kind.value,
        amount_cents: cents,
        account_id: accountId.value,
        to_account_id: kind.value === 'transfer' ? toAccountId.value : undefined,
        category_id: kind.value === 'transfer' ? undefined : categoryId.value,
        date: date.value,
        note: note.value,
        excluded: excluded.value,
      }),
    })
    if (file.value) {
      const fd = new FormData()
      fd.append('file', file.value)
      await api(`/api/v1/transactions/${saved.id}/receipt`, { method: 'POST', body: fd })
    }
    savePrefs(session.ledgerId, {
      accountId: accountId.value,
      expenseCat: kind.value === 'expense' ? categoryId.value : undefined,
      incomeCat: kind.value === 'income' ? categoryId.value : undefined,
    })
    if (again) {
      amount.value = ''
      note.value = ''
      file.value = null
      savedHint.value = '已保存，继续记'
      return
    }
    router.replace('/')
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    loading.value = false
  }
}

async function remove() {
  if (!id.value || !confirm('删除这条记录？')) return
  await api(`/api/v1/transactions/${id.value}`, { method: 'DELETE' })
  router.replace('/')
}

async function removeReceipt() {
  if (!id.value) return
  await api(`/api/v1/transactions/${id.value}/receipt`, { method: 'DELETE' })
  hasReceipt.value = false
  file.value = null
}

async function viewReceipt() {
  if (!id.value) return
  const res = await fetch(`/api/v1/transactions/${id.value}/receipt`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-ledger-id': session.ledgerId,
    },
  })
  if (!res.ok) return
  const url = URL.createObjectURL(await res.blob())
  window.open(url, '_blank')
}

function switchKind(k: 'expense' | 'income' | 'transfer') {
  kind.value = k
  if (k !== 'transfer' && !visibleCats.value.some((c) => c.id === categoryId.value)) {
    categoryId.value = visibleCats.value[0]?.id ?? ''
  }
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  file.value = input.files?.[0] ?? null
}

watch(() => route.fullPath, load, { immediate: true })
watch([kind, date], loadStats)
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" @click="router.back()">‹</button>
      <h1>{{ id ? '改一笔' : '记一笔' }}</h1>
      <LedgerName />
    </div>
    <div class="kind three">
      <button class="expense" :class="{ on: kind === 'expense' }" @click="switchKind('expense')">支出</button>
      <button class="income" :class="{ on: kind === 'income' }" @click="switchKind('income')">收入</button>
      <button :class="{ on: kind === 'transfer' }" @click="switchKind('transfer')">转账</button>
    </div>
    <div class="card">
      <label class="field">
        <span>金额（元）</span>
        <input ref="amountEl" v-model="amount" class="amount-input" inputmode="decimal" placeholder="0.00 或 12+8" />
        <span v-if="amountPreview" class="muted">= {{ amountPreview }}</span>
        <span v-if="budgetState.text" :class="budgetState.over ? 'err' : 'muted'">{{ budgetState.text }}</span>
      </label>
      <label class="field">
        <span>日期</span>
        <input v-model="date" type="date" />
        <div class="chips" style="margin-top: 6px">
          <button type="button" class="chip" :class="{ on: date === today }" @click="date = today">今天</button>
          <button type="button" class="chip" :class="{ on: date === yesterday }" @click="date = yesterday">昨天</button>
        </div>
      </label>
      <label class="field">
        <span>{{ kind === 'transfer' ? '转出账户' : '账户' }}</span>
        <select v-model="accountId">
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label v-if="kind === 'transfer'" class="field">
        <span>转入账户</span>
        <select v-model="toAccountId">
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <div v-if="kind !== 'transfer'" class="field">
        <span>分类</span>
        <div class="chips">
          <button
            v-for="c in visibleCats"
            :key="c.id"
            class="chip"
            :class="{ on: categoryId === c.id }"
            @click="categoryId = c.id"
          >{{ c.name }}</button>
        </div>
      </div>
      <label class="field"><span>备注</span><input v-model="note" maxlength="200" /></label>
      <label class="field">
        <span>收据（可选，≤512KB）</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" @change="onFile" />
      </label>
      <p v-if="hasReceipt && id" class="muted">
        已有收据
        <button class="btn ghost" style="width:auto;padding:4px 8px" @click="viewReceipt">查看</button>
        · <button class="btn ghost" style="width:auto;padding:4px 8px" @click="removeReceipt">删除图片</button>
      </p>
      <label class="check"><input type="checkbox" v-model="excluded" /> 不计入收支（报销等）</label>
      <p v-if="savedHint" class="muted">{{ savedHint }}</p>
      <p v-if="err" class="err">{{ err }}</p>
      <button class="btn" :disabled="loading" @click="save(false)">保存</button>
      <button v-if="!id" class="btn ghost" style="margin-top: 8px" :disabled="loading" @click="save(true)">再记一笔</button>
      <button v-if="id" class="btn ghost" style="margin-top: 8px" @click="remove">删除</button>
    </div>
  </div>
</template>
