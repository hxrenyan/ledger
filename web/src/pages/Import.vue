<script setup lang="ts">
/**
 * 账单导入：选文件 → 预览修正 → 确认入库。
 *
 * 文件在浏览器里解码/解析（GBK 与 xlsx 都走前端），后端只收 UTF-8 文本或二维表；
 * 预览阶段不落库，用户改完分类/账户再提交。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type ImportBatch, type ImportCommitResult, type ImportPreview, type ImportPreviewRow } from '../api.ts'
import { readImportFile, type ReadResult } from '../importFile.ts'
import { formatYuan } from '../money.ts'

const router = useRouter()

const file = ref<File | null>(null)
const input = ref<ReadResult | null>(null)
const sheet = ref('')
const preview = ref<ImportPreview | null>(null)
const rows = ref<ImportPreviewRow[]>([])
const batches = ref<ImportBatch[]>([])
const result = ref<ImportCommitResult | null>(null)
const busy = ref(false)
const err = ref('')
const msg = ref('')
const visible = ref(60)
const editing = ref<number | null>(null)

const importable = computed(() => rows.value.filter((r) => r.status === 'ok' && r.direction !== 'skip').length)
const problemCount = computed(() => rows.value.filter((r) => r.status === 'error').length)
const duplicateCount = computed(() => rows.value.filter((r) => r.status === 'ok' && r.duplicate).length)
const shown = computed(() => rows.value.slice(0, visible.value))

const SOURCE_LABEL: Record<string, string> = {
  wechat: '微信账单',
  alipay: '支付宝账单',
  bank: '银行流水',
  generic: '通用表格',
  json: 'JSON 数据',
  ai: 'AI 解析',
}

async function pickFile(e: Event) {
  const el = e.target as HTMLInputElement
  const picked = el.files?.[0]
  if (!picked) return
  err.value = ''
  msg.value = ''
  preview.value = null
  result.value = null
  file.value = picked
  try {
    const read = await readImportFile(picked)
    input.value = read
    sheet.value = read.kind === 'rows' ? read.sheet : ''
  } catch (e2) {
    input.value = null
    err.value = e2 instanceof Error ? e2.message : '文件读取失败'
  }
}

async function switchSheet() {
  if (!file.value) return
  err.value = ''
  try {
    const read = await readImportFile(file.value, sheet.value)
    input.value = read
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : '工作表读取失败'
  }
}

async function doPreview(useAi = false) {
  if (!input.value) return
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    const body =
      input.value.kind === 'rows'
        ? { kind: 'rows' as const, rows: input.value.rows, filename: input.value.filename, sheet: input.value.sheet, use_ai: useAi }
        : { kind: 'text' as const, text: input.value.text, filename: input.value.filename, use_ai: useAi }
    const data = await api<ImportPreview>('/api/v1/imports/preview', { method: 'POST', body: JSON.stringify(body) })
    preview.value = data
    rows.value = data.rows.map((r) => ({ ...r }))
    visible.value = 60
    editing.value = null
    if (data.truncated) msg.value = `文件较大，本次仅预览前 ${data.rows.length} 行，建议拆分文件分次导入`
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : '解析失败'
  } finally {
    busy.value = false
  }
}

async function suggest() {
  if (!preview.value) return
  busy.value = true
  err.value = ''
  try {
    const payload = rows.value
      .filter((r) => r.status === 'ok')
      .slice(0, 300)
      .map((r) => ({ i: r.row, note: r.note, counterparty: r.counterparty, direction: r.direction === 'income' ? 'income' : 'expense', amount_cents: r.amount_cents }))
    const data = await api<{ applied: Record<string, string>; error?: string }>('/api/v1/imports/suggest', {
      method: 'POST',
      body: JSON.stringify({ rows: payload }),
    })
    if (data.error) {
      err.value = data.error
      return
    }
    const byName = new Map(preview.value.categories.map((c) => [c.name, c]))
    let n = 0
    for (const r of rows.value) {
      const name = data.applied[String(r.row)]
      if (!name) continue
      const cat = byName.get(name)
      if (!cat || cat.kind !== r.direction) continue
      r.category_id = cat.id
      r.category_name = cat.name
      n++
    }
    msg.value = `AI 已更新 ${n} 行的分类`
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : 'AI 建议失败'
  } finally {
    busy.value = false
  }
}

async function commit() {
  if (!preview.value) return
  const payload = rows.value
    .filter((r) => r.status === 'ok' && r.direction !== 'skip')
    .map((r) => ({
      date: r.date,
      amount_cents: r.amount_cents,
      direction: r.direction,
      note: r.note,
      category_id: r.category_id,
      account_id: r.account_id,
      favor_contact: r.favor_contact,
      favor_kind: r.favor_kind,
      favor_occasion: r.favor_occasion,
    }))
  if (!payload.length) {
    err.value = '没有可导入的行'
    return
  }
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    const data = await api<ImportCommitResult>('/api/v1/imports/commit', {
      method: 'POST',
      body: JSON.stringify({
        source: preview.value.source,
        filename: preview.value.filename,
        sheet: preview.value.sheet,
        ai_used: preview.value.ai.used,
        rows: payload,
      }),
    })
    result.value = data
    await loadBatches()
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : '导入失败'
  } finally {
    busy.value = false
  }
}

async function loadBatches() {
  try {
    const data = await api<{ items: ImportBatch[] }>('/api/v1/imports/batches?limit=10')
    batches.value = data.items
  } catch {
    /* 列表失败不影响主流程 */
  }
}

async function undo(batch: ImportBatch) {
  if (!confirm(`撤销这次导入？将删除该批次写入的 ${batch.imported_rows} 笔流水并恢复余额。`)) return
  busy.value = true
  err.value = ''
  try {
    await api(`/api/v1/imports/batches/${batch.id}/undo`, { method: 'POST' })
    msg.value = '已撤销该批次'
    await loadBatches()
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : '撤销失败'
  } finally {
    busy.value = false
  }
}

function reset() {
  preview.value = null
  result.value = null
  rows.value = []
  input.value = null
  file.value = null
  err.value = ''
  msg.value = ''
}

function sign(r: ImportPreviewRow): string {
  if (r.direction === 'expense') return '-'
  if (r.direction === 'income') return '+'
  return ''
}

function categoriesFor(direction: string) {
  return (preview.value?.categories ?? []).filter((c) => c.kind === direction)
}

function when(ms: number) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

onMounted(loadBatches)
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" type="button" @click="router.back()">←</button>
      <h1 style="margin:0">导入账单</h1>
    </div>

    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="msg" class="muted">{{ msg }}</p>

    <!-- 1. 选文件 -->
    <div v-if="!preview" class="card">
      <div class="field">
        <span>账单文件</span>
        <input type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls,.xlsm" @change="pickFile" />
      </div>
      <p class="muted">
        支持微信 / 支付宝 / 银行导出的 CSV、Excel（xlsx/xls）、JSON。文件在浏览器里解码解析，原始文件不会上传。
      </p>
      <p v-if="input" class="muted">
        已读取：{{ input.filename }}
        <template v-if="input.kind === 'text'"> · 编码 {{ input.encoding }}</template>
        <template v-else> · 工作表 {{ input.sheet }} · {{ input.rows.length }} 行</template>
      </p>
      <div v-if="input && input.kind === 'rows' && input.sheets.length > 1" class="field">
        <span>工作表</span>
        <select v-model="sheet" @change="switchSheet">
          <option v-for="s in input.sheets" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>
      <button class="btn" :disabled="!input || busy" @click="doPreview(false)">
        {{ busy ? '解析中…' : '解析预览' }}
      </button>
    </div>

    <!-- 2. 预览确认 -->
    <template v-if="preview">
      <div class="card" style="margin-bottom:12px">
        <div class="summary" style="margin:0 0 8px">
          <div>
            <div class="k muted">可导入</div>
            <div class="v">{{ importable }}</div>
          </div>
          <div>
            <div class="k muted">跳过 / 失败 / 疑似重复</div>
            <div class="v" style="font-size:16px">{{ preview.stats.skip }} / {{ problemCount }} / {{ duplicateCount }}</div>
          </div>
        </div>
        <p class="muted" style="margin:0">
          识别为 {{ SOURCE_LABEL[preview.source] ?? preview.source }}
          <template v-if="preview.header_index >= 0"> · 表头在第 {{ preview.header_index + 1 }} 行</template>
          <template v-else> · 无表头</template>
          <template v-if="preview.ai.used"> · 已用 AI 解析</template>
          <template v-if="preview.filename"> · {{ preview.filename }}</template>
        </p>
        <p v-if="preview.ai.error" class="err" style="margin:8px 0 0">AI：{{ preview.ai.error }}</p>
        <div class="inline" style="margin-top:10px">
          <button class="btn ghost" style="width:auto" :disabled="busy || !preview.ai.available" @click="suggest">AI 建议分类</button>
          <button class="btn ghost" style="width:auto" :disabled="busy" @click="doPreview(true)">用 AI 重解析</button>
          <button class="btn ghost" style="width:auto" :disabled="busy" @click="reset">重选文件</button>
        </div>
      </div>

      <div class="card">
        <div v-for="r in shown" :key="r.row" class="row" style="display:block" @click="editing = editing === r.row ? null : r.row">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <div style="min-width:0">
              <div style="font-size:14px">
                {{ r.date || '日期缺失' }} · {{ r.note || r.counterparty || '（无备注）' }}
              </div>
              <div class="muted">
                <template v-if="r.status === 'error'"><span class="expense">{{ r.reason }}</span></template>
                <template v-else-if="r.direction === 'skip'">跳过 · {{ r.reason }}</template>
                <template v-else>
                  {{ r.category_name || '未分类' }} · {{ r.account_name || '未选账户' }}
                  <span v-if="r.favor_contact"> · 人情 {{ r.favor_kind === 'give' ? '送出' : '收入' }} {{ r.favor_contact }} {{ r.favor_occasion }}</span>
                  <span v-if="r.duplicate" class="expense"> · 疑似重复</span>
                </template>
                <span> · 第 {{ r.row }} 行</span>
              </div>
            </div>
            <div class="amount" :class="r.direction === 'expense' ? 'expense' : r.direction === 'income' ? 'income' : ''">
              {{ sign(r) }}{{ formatYuan(r.amount_cents) }}
            </div>
          </div>

          <div v-if="editing === r.row" style="margin-top:10px">
            <div class="kind three">
              <button :class="{ on: r.direction === 'expense', expense: true }" @click.stop="r.direction = 'expense'">支出</button>
              <button :class="{ on: r.direction === 'income', income: true }" @click.stop="r.direction = 'income'">收入</button>
              <button :class="{ on: r.direction === 'skip' }" @click.stop="r.direction = 'skip'">跳过</button>
            </div>
            <div v-if="r.direction !== 'skip'" class="field">
              <span>分类</span>
              <select v-model="r.category_id" @click.stop>
                <option value="">未分类</option>
                <option v-for="c in categoriesFor(r.direction)" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div v-if="r.direction !== 'skip'" class="field">
              <span>账户</span>
              <select v-model="r.account_id" @click.stop>
                <option value="">未选账户</option>
                <option v-for="a in preview.accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
              </select>
            </div>
            <div class="field">
              <span>备注</span>
              <input v-model="r.note" @click.stop />
            </div>
            <div class="field" v-if="r.direction !== 'skip'">
              <span>人情往来（留空表示不记）</span>
              <input v-model="r.favor_contact" placeholder="对方姓名" @click.stop />
            </div>
            <p class="muted" style="margin:0">第 {{ r.row }} 行原始候选：{{ r.counterparty || '（无）' }}</p>
          </div>
        </div>

        <button v-if="visible < rows.length" class="btn ghost" style="margin-top:12px" @click="visible += 60">
          显示更多（还有 {{ rows.length - visible }} 行）
        </button>
      </div>

      <p v-if="problemCount" class="muted">
        {{ problemCount }} 行有问题（日期/金额识别失败），可在列表里手动改方向或跳过；失败行不会写库。
      </p>

      <button class="btn" style="margin-top:12px" :disabled="busy || !importable" @click="commit">
        {{ busy ? '导入中…' : `导入 ${importable} 笔` }}
      </button>
    </template>

    <!-- 3. 结果 -->
    <div v-if="result" class="card" style="margin-top:12px">
      <h2>导入完成</h2>
      <p class="muted" style="margin:0">
        写入 {{ result.imported }} 笔 · 跳过 {{ result.skipped }} 行 · 重复 {{ result.duplicates }} 行 · 失败 {{ result.failed.length }} 行
      </p>
      <p v-if="result.failed.length" class="err">
        {{ result.failed.slice(0, 5).map((f) => `第 ${f.row} 行：${f.reason}`).join('；') }}
      </p>
    </div>

    <!-- 4. 历史批次 -->
    <div v-if="batches.length" class="card" style="margin-top:12px">
      <h2>最近导入</h2>
      <div v-for="b in batches" :key="b.id" class="row">
        <div>
          <div style="font-size:14px">{{ SOURCE_LABEL[b.source] ?? b.source }}{{ b.filename ? ` · ${b.filename}` : '' }}</div>
          <div class="muted">
            {{ when(b.created_at) }} · 写入 {{ b.imported_rows }} · 跳过 {{ b.skipped_rows }} · 重复 {{ b.duplicate_rows }}
            <template v-if="b.ai_used"> · AI</template>
            <template v-if="b.status === 'undone'"> · <span class="expense">已撤销</span></template>
          </div>
        </div>
        <button v-if="b.status === 'done'" class="btn ghost" style="width:auto" :disabled="busy" @click="undo(b)">撤销</button>
      </div>
    </div>
  </div>
</template>
