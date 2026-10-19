<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { centsToYuan, yuanExprToCents } from '@server/money.ts'
import { addDays, occurredAtToDate, shanghaiDate } from '@server/time.ts'
import { api } from '../../tools/session.ts'

const OCCASIONS = ['婚礼', '满月', '乔迁', '生日', '探病', '升学', '白事', '节日']
const QUICK_AMOUNTS = ['200', '500', '600', '800', '1000', '2000']

type Kind = 'give' | 'receive'
type Contact = { id: number; name: string; relation: string; archived: boolean }
type Account = { id: number; name: string; archived: boolean }
type Category = { id: number; name: string; kind: 'expense' | 'income'; archived: boolean }
type Gift = {
  id: number
  contact_id: number
  contact_name?: string
  kind: Kind
  amount_cents: number
  occasion: string
  occurred_at: number
  note: string
}

const route = useRoute()
const router = useRouter()
const isNew = computed(() => route.path.endsWith('/gifts/new'))
const giftId = computed(() => (isNew.value ? '' : String(route.params.giftId || '')))
const presetContactId = computed(() => String(route.params.contactId || ''))

const kind = ref<Kind>('give')
const amountText = ref('')
const date = ref(shanghaiDate())
const occasion = ref('')
const customOccasion = ref('')
const writing = ref(false)
const note = ref('')
const contactId = ref('')
const contacts = ref<Contact[]>([])
const accounts = ref<Account[]>([])
const categories = ref<Category[]>([])
const accountId = ref('')
const categoryId = ref('')
const alsoTx = ref(false)
const keepGoing = ref(false)
const converting = ref(false)
const namingCategory = ref(false)
const categoryDraft = ref('')
const error = ref('')
const notice = ref('')
const loading = ref(true)
const saving = ref(false)

const today = shanghaiDate()
const txKind = computed(() => (kind.value === 'receive' ? 'income' : 'expense'))
const activeContacts = computed(() => contacts.value.filter((item) => !item.archived))
const contactOptions = computed(() => {
  const list = activeContacts.value.slice()
  const current = contacts.value.find((item) => String(item.id) === contactId.value)
  if (current && !list.some((item) => item.id === current.id)) list.unshift(current)
  return list
})
const currentCategories = computed(() => categories.value.filter((item) => !item.archived && item.kind === txKind.value))
const activeAccounts = computed(() => accounts.value.filter((item) => !item.archived))
const amountPreview = computed(() => {
  const text = amountText.value.trim()
  if (!text || !/[+\-*/＋－×÷]/.test(text)) return ''
  const cents = yuanExprToCents(text)
  return cents ? `= ¥${centsToYuan(cents)}` : '算式待完成…'
})
const datePreset = computed(() => {
  if (date.value === today) return 'today'
  if (date.value === addDays(today, -1)) return 'yesterday'
  if (date.value === addDays(today, -2)) return 'beforeYesterday'
  return ''
})
const backTo = computed(() => `/tools/contacts/${contactId.value || presetContactId.value}/records`)

onMounted(async () => {
  try {
    const [contactBody, accountBody, categoryBody] = await Promise.all([
      api<{ items: Contact[] }>('/api/v1/contacts'),
      api<{ items: Account[] }>('/api/v1/accounts'),
      api<{ items: Category[] }>('/api/v1/categories'),
    ])
    contacts.value = contactBody.items || []
    accounts.value = accountBody.items || []
    categories.value = categoryBody.items || []
    accountId.value = activeAccounts.value[0] ? String(activeAccounts.value[0].id) : ''
    if (isNew.value) {
      contactId.value = presetContactId.value
      pickDefaultCategory()
    } else {
      await loadGift()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
})

async function loadGift() {
  const gift = await api<Gift>(`/api/v1/gifts/${giftId.value}`)
  kind.value = gift.kind
  amountText.value = centsToYuan(gift.amount_cents)
  date.value = occurredAtToDate(gift.occurred_at)
  note.value = gift.note || ''
  contactId.value = String(gift.contact_id)
  if (gift.occasion && OCCASIONS.includes(gift.occasion)) {
    occasion.value = gift.occasion
    writing.value = false
    customOccasion.value = ''
  } else {
    occasion.value = ''
    writing.value = !!gift.occasion
    customOccasion.value = gift.occasion || ''
  }
  pickDefaultCategory()
}

function pickDefaultCategory() {
  const list = currentCategories.value
  if (!list.some((item) => String(item.id) === categoryId.value)) {
    categoryId.value = list[0] ? String(list[0].id) : ''
  }
}

function setKind(next: Kind) {
  if (kind.value === next) return
  kind.value = next
  error.value = ''
  pickDefaultCategory()
}

function pickOccasion(value: string) {
  writing.value = false
  customOccasion.value = ''
  occasion.value = occasion.value === value ? '' : value
}

function startCustom() {
  if (writing.value) {
    writing.value = false
    customOccasion.value = ''
    return
  }
  occasion.value = ''
  writing.value = true
}

function pickDate(preset: 'today' | 'yesterday' | 'beforeYesterday') {
  if (preset === 'today') date.value = today
  if (preset === 'yesterday') date.value = addDays(today, -1)
  if (preset === 'beforeYesterday') date.value = addDays(today, -2)
}

function occasionText() {
  return (writing.value ? customOccasion.value : occasion.value).trim()
}

function centsOf() {
  return yuanExprToCents(amountText.value)
}

async function addCategory() {
  const name = categoryDraft.value.trim()
  if (!name || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const created = await api<Category>('/api/v1/categories', {
      method: 'POST',
      body: JSON.stringify({ name, kind: txKind.value }),
    })
    categories.value.push(created)
    categoryId.value = String(created.id)
    categoryDraft.value = ''
    namingCategory.value = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : '新增分类失败'
  } finally {
    saving.value = false
  }
}

async function save() {
  if (saving.value) return
  const cents = centsOf()
  if (!cents) {
    error.value = '金额填一下'
    return
  }
  if (!contactId.value) {
    error.value = '请选择对方'
    return
  }
  const occasionValue = occasionText()
  if ([...occasionValue].length > 16) {
    error.value = '事由最多 16 字'
    return
  }
  if (isNew.value && alsoTx.value && !accountId.value) {
    error.value = '请选择账户'
    return
  }
  if (isNew.value && alsoTx.value && !categoryId.value) {
    error.value = '请选择分类'
    return
  }
  const payload: Record<string, unknown> = {
    contact_id: Number(contactId.value),
    kind: kind.value,
    amount_cents: cents,
    date: date.value,
    occasion: occasionValue,
    note: note.value.trim(),
  }
  if (isNew.value && alsoTx.value) {
    payload.account_id = Number(accountId.value)
    payload.category_id = Number(categoryId.value)
  }
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    if (isNew.value) {
      await api('/api/v1/gifts', { method: 'POST', body: JSON.stringify(payload) })
      if (keepGoing.value) {
        amountText.value = ''
        note.value = ''
        notice.value = alsoTx.value ? '人情和明细已记下，继续' : '已记下，继续'
        return
      }
    } else {
      await api(`/api/v1/gifts/${giftId.value}`, { method: 'PATCH', body: JSON.stringify(payload) })
    }
    await router.replace(backTo.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (isNew.value || saving.value) return
  if (!window.confirm('删掉这条人情记录？')) return
  saving.value = true
  error.value = ''
  try {
    await api(`/api/v1/gifts/${giftId.value}`, { method: 'DELETE' })
    await router.replace(backTo.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除失败'
  } finally {
    saving.value = false
  }
}

async function toTransaction() {
  if (isNew.value || saving.value) return
  const cents = centsOf()
  if (!cents) {
    error.value = '金额填一下'
    return
  }
  if (!accountId.value) {
    error.value = '请选择账户'
    return
  }
  if (!categoryId.value) {
    error.value = '请选择分类'
    return
  }
  if (!window.confirm('这条会从人情里拿掉，改记到明细并计入所选账户。')) return
  saving.value = true
  error.value = ''
  try {
    await api(`/api/v1/gifts/${giftId.value}/to-transaction`, {
      method: 'POST',
      body: JSON.stringify({
        kind: txKind.value,
        amount_cents: cents,
        account_id: Number(accountId.value),
        category_id: Number(categoryId.value),
        date: date.value,
        note: note.value.trim(),
      }),
    })
    await router.replace(backTo.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '转成明细失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="tools-head">
    <button class="btn ghost compact" type="button" @click="router.replace(backTo)">‹ 返回</button>
    <h1>{{ isNew ? '记人情' : '改人情' }}</h1>
  </div>
  <p v-if="loading" class="muted">加载中…</p>
  <form v-else @submit.prevent="save">
    <div class="kind">
      <button type="button" :class="{ on: kind === 'give', expense: kind === 'give' }" @click="setKind('give')">送出（随礼）</button>
      <button type="button" :class="{ on: kind === 'receive', income: kind === 'receive' }" @click="setKind('receive')">收到（收礼）</button>
    </div>

    <div class="card">
      <label class="field">
        <span>金额</span>
        <input v-model="amountText" inputmode="decimal" placeholder="0.00，也可以写 1000+200" />
      </label>
      <p class="muted">{{ amountPreview || '点选常用礼金，或直接输入算式' }}</p>
      <div class="chips">
        <button
          v-for="item in QUICK_AMOUNTS"
          :key="item"
          type="button"
          class="chip"
          :class="{ on: amountText === item }"
          @click="amountText = item"
        >
          ¥{{ item }}
        </button>
      </div>
    </div>

    <div class="card">
      <label class="field">
        <span>对方</span>
        <select v-model="contactId">
          <option v-if="!contactOptions.length" value="">还没有联系人</option>
          <option v-for="item in contactOptions" :key="item.id" :value="String(item.id)">
            {{ item.name }}{{ item.relation ? `（${item.relation}）` : '' }}
          </option>
        </select>
      </label>
      <div class="date-head">
        <span>事由</span>
        <small class="muted">选填，再点一次可取消</small>
      </div>
      <div class="chips">
        <button
          v-for="item in OCCASIONS"
          :key="item"
          type="button"
          class="chip"
          :class="{ on: !writing && occasion === item }"
          @click="pickOccasion(item)"
        >
          {{ item }}
        </button>
        <button type="button" class="chip" :class="{ on: writing }" @click="startCustom">
          {{ writing && customOccasion.trim() ? customOccasion.trim() : '＋ 自己写' }}
        </button>
      </div>
      <input v-if="writing" v-model="customOccasion" maxlength="16" placeholder="输入自定义事由（最多 16 字）" />
    </div>

    <div class="card">
      <div class="chips">
        <button type="button" class="chip" :class="{ on: datePreset === 'today' }" @click="pickDate('today')">今天</button>
        <button type="button" class="chip" :class="{ on: datePreset === 'yesterday' }" @click="pickDate('yesterday')">昨天</button>
        <button type="button" class="chip" :class="{ on: datePreset === 'beforeYesterday' }" @click="pickDate('beforeYesterday')">前天</button>
      </div>
      <label class="field">
        <span>日期</span>
        <input v-model="date" type="date" />
      </label>
      <label class="field">
        <span>备注</span>
        <input v-model="note" maxlength="200" placeholder="比如：随了 800，回礼或伴手礼说明" />
      </label>

      <template v-if="isNew">
        <label class="check"><input v-model="alsoTx" type="checkbox" /> 同时记入明细</label>
        <label class="check"><input v-model="keepGoing" type="checkbox" /> 继续记下一笔</label>
      </template>
      <button v-else class="btn ghost compact" type="button" @click="converting = !converting">
        {{ converting ? '收起转成明细' : '转成明细' }}
      </button>

      <div v-if="(isNew && alsoTx) || converting" class="also">
        <p class="muted">
          {{
            converting
              ? '这条人情会删掉，改记成一笔流水，计入所选账户。'
              : (kind === 'receive' ? '收到将同步生成一笔收入流水' : '送出将同步生成一笔支出流水') + '，计入所选账户余额。'
          }}
        </p>
        <div class="date-head">
          <span>{{ kind === 'receive' ? '收入分类' : '支出分类' }}</span>
          <button type="button" class="link" @click="namingCategory = !namingCategory">＋ 新增</button>
        </div>
        <div v-if="namingCategory" class="custom-row">
          <input v-model="categoryDraft" maxlength="32" placeholder="分类名称" />
          <button class="btn compact" type="button" :disabled="saving || !categoryDraft.trim()" @click="addCategory">确定</button>
        </div>
        <div class="chips">
          <button
            v-for="item in currentCategories"
            :key="item.id"
            type="button"
            class="chip"
            :class="{ on: categoryId === String(item.id) }"
            @click="categoryId = String(item.id)"
          >
            {{ item.name }}
          </button>
        </div>
        <div class="date-head"><span>记入账户</span></div>
        <div class="chips">
          <button
            v-for="item in activeAccounts"
            :key="item.id"
            type="button"
            class="chip"
            :class="{ on: accountId === String(item.id) }"
            @click="accountId = String(item.id)"
          >
            {{ item.name }}
          </button>
        </div>
        <button v-if="converting" class="btn danger" type="button" :disabled="saving" @click="toTransaction">确认转成明细</button>
      </div>
    </div>

    <p v-if="notice" class="muted">{{ notice }}</p>
    <p v-if="error" class="err">{{ error }}</p>
    <div class="actions">
      <button v-if="!isNew" class="btn danger" type="button" :disabled="saving" @click="remove">删除</button>
      <button class="btn" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
    </div>
  </form>
</template>

<style scoped>
.tools-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.tools-head h1 { margin: 0; flex: 1; font-size: 20px; text-align: center; }
.tools-head .btn { width: auto; min-height: 36px; padding: 6px 12px; }
.date-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 12px 0 8px;
  font-size: 13px;
  color: var(--muted);
}
.chips { margin-bottom: 8px; }
.check { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
.custom-row { display: flex; gap: 8px; margin-bottom: 8px; }
.custom-row input { flex: 1; }
.custom-row .btn { width: auto; }
.link { border: 0; background: transparent; color: var(--brand); }
.also { margin-top: 8px; }
.actions { display: flex; gap: 10px; }
</style>
