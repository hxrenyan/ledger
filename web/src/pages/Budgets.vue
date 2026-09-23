<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import MonthNav from '../components/MonthNav.vue'
import { api, type Category } from '../api.ts'
import { formatYuan, yuanInputToCents } from '../money.ts'
import { addMonth, shanghaiMonth } from '@server/time.ts'

type Budget = { id: string; category_id: string | null; amount_cents: number }
type CatStat = { category_id: string; name: string; kind: string; amount_cents: number; budget_cents: number }

/**
 * 预算页，布局与小程序 pages/budgets 同构。
 *
 * 月份上限传「下个月」—— 预算是唯一允许提前设的页面。
 * 总预算与分类预算都是「清空并保存 = 删除」（PUT 不收 0，删除走 DELETE）。
 */
const maxMonth = addMonth(shanghaiMonth(), 1)
const month = ref(shanghaiMonth())
const totalYuan = ref('')
const totalBudgetId = ref('')
const catYuan = ref<Record<string, string>>({})
const editing = ref('')
const cats = ref<Category[]>([])
const budgets = ref<Budget[]>([])
const stats = ref<{ expense_cents: number; budget_cents: number; by_category: CatStat[] }>({
  expense_cents: 0,
  budget_cents: 0,
  by_category: [],
})
const err = ref('')

const expenseCats = computed(() => cats.value.filter((c) => c.kind === 'expense' && !c.archived))
const totalCents = computed(() => budgets.value.find((x) => !x.category_id)?.amount_cents ?? 0)
const totalPct = computed(() =>
  totalCents.value ? Math.min(100, Math.round((stats.value.expense_cents / totalCents.value) * 100)) : 0,
)
const totalOver = computed(() => totalCents.value > 0 && stats.value.expense_cents > totalCents.value)

function spentOf(catId: string) {
  return stats.value.by_category.find((x) => x.category_id === catId)?.amount_cents ?? 0
}
function budgetOf(catId: string) {
  return budgets.value.find((x) => x.category_id === catId)?.amount_cents ?? 0
}
function budgetIdOf(catId: string) {
  return budgets.value.find((x) => x.category_id === catId)?.id ?? ''
}
function pctOf(catId: string) {
  const b = budgetOf(catId)
  return b ? Math.min(100, Math.round((spentOf(catId) / b) * 100)) : 0
}
function overOf(catId: string) {
  const b = budgetOf(catId)
  return b > 0 && spentOf(catId) > b
}

async function load() {
  err.value = ''
  const [b, s, c] = await Promise.all([
    api<{ items: Budget[] }>(`/api/v1/budgets?month=${month.value}`),
    api<typeof stats.value>(`/api/v1/stats/monthly?month=${month.value}`),
    api<{ items: Category[] }>('/api/v1/categories'),
  ])
  budgets.value = b.items
  stats.value = s
  cats.value = c.items
  totalBudgetId.value = b.items.find((x) => !x.category_id)?.id ?? ''
  totalYuan.value = totalBudgetId.value ? formatYuan(totalCents.value) : ''
  const next: Record<string, string> = {}
  for (const x of b.items) {
    if (x.category_id) next[x.category_id] = formatYuan(x.amount_cents)
  }
  catYuan.value = next
}

/** 清空并保存 = 删除这项预算。 */
async function saveTotal() {
  err.value = ''
  const cents = yuanInputToCents(totalYuan.value)
  try {
    if (!cents) {
      if (totalBudgetId.value) {
        await api(`/api/v1/budgets/${totalBudgetId.value}`, { method: 'DELETE' })
        totalYuan.value = ''
      }
    } else {
      await api('/api/v1/budgets', {
        method: 'PUT',
        body: JSON.stringify({ month: month.value, amount_cents: cents, category_id: '' }),
      })
    }
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  }
}

async function saveCat(id: string) {
  err.value = ''
  const cents = yuanInputToCents(catYuan.value[id] ?? '')
  try {
    if (!cents) {
      const bid = budgetIdOf(id)
      if (bid) await api(`/api/v1/budgets/${bid}`, { method: 'DELETE' })
      catYuan.value[id] = ''
    } else {
      await api('/api/v1/budgets', {
        method: 'PUT',
        body: JSON.stringify({ month: month.value, amount_cents: cents, category_id: id }),
      })
    }
    editing.value = ''
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  }
}

function onMonthChange(m: string) {
  month.value = m
}

onMounted(load)
watch(month, load)
</script>

<template>
  <div class="page">
    <MonthNav :month="month" :max="maxMonth" @change="onMonthChange" />

    <div class="card" style="margin-bottom: 12px">
      <div class="row" style="border-bottom: 0; padding-top: 0">
        <div>
          <div>总预算</div>
          <div class="muted">
            本月已花 {{ formatYuan(stats.expense_cents) }}<template v-if="totalCents"> · 已用 {{ totalPct }}%</template>
          </div>
        </div>
        <div class="amount">{{ totalCents ? formatYuan(totalCents) : '未设置' }}</div>
      </div>
      <div class="bar" :class="{ over: totalOver }">
        <i :style="{ width: totalPct + '%' }"></i>
      </div>
      <p class="muted" style="margin: 8px 0 0">
        {{ totalCents ? (totalOver ? '已超出预算' : `已用 ${totalPct}%`) : '还没设总预算' }}
      </p>
      <div class="inline" style="margin-top: 12px">
        <input v-model="totalYuan" inputmode="decimal" placeholder="总预算（元）" />
        <button class="btn" type="button" @click="saveTotal">保存</button>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
      <p class="muted" style="margin: 8px 0 0">清空输入框并保存，就是删掉这项预算。</p>
    </div>

    <div class="card">
      <h2>分类预算</h2>
      <div v-if="!expenseCats.length" class="muted">还没有支出分类</div>
      <div
        v-for="c in expenseCats"
        :key="c.id"
        class="row"
        @click="editing = editing === c.id ? '' : c.id"
      >
        <div>
          <div>{{ c.name }}</div>
          <div class="muted">
            已花 {{ formatYuan(spentOf(c.id)) }}<template v-if="budgetOf(c.id)"> / {{ formatYuan(budgetOf(c.id)) }}</template>
          </div>
          <div class="bar" :class="{ over: overOf(c.id) }" style="margin-top: 8px">
            <i :style="{ width: pctOf(c.id) + '%' }"></i>
          </div>
        </div>
        <span v-if="!budgetOf(c.id)" class="muted">设定 ›</span>
      </div>
      <template v-for="c in expenseCats" :key="'edit-' + c.id">
        <div v-if="editing === c.id" class="inline" style="margin-top: 12px">
          <input v-model="catYuan[c.id]" inputmode="decimal" placeholder="0.00" @keyup.enter="saveCat(c.id)" />
          <button class="btn" type="button" @click="saveCat(c.id)">保存</button>
        </div>
      </template>
      <p v-if="err && editing" class="err">{{ err }}</p>
      <p class="muted" style="margin: 12px 0 0">点某一项设置金额；清空并保存就能删掉。</p>
    </div>
  </div>
</template>
