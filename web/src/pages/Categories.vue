<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type Category } from '../api.ts'

const router = useRouter()

const items = ref<Category[]>([])
const name = ref('')
const kind = ref<'expense' | 'income'>('expense')
const err = ref('')

const grouped = computed(() => ({
  expense: items.value.filter((c) => c.kind === 'expense'),
  income: items.value.filter((c) => c.kind === 'income'),
}))

async function load() {
  items.value = (await api<{ items: Category[] }>('/api/v1/categories')).items
}

async function add() {
  err.value = ''
  try {
    await api('/api/v1/categories', {
      method: 'POST',
      body: JSON.stringify({ name: name.value, kind: kind.value }),
    })
    name.value = ''
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '失败'
  }
}

async function toggle(c: Category) {
  await api(`/api/v1/categories/${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: !c.archived }),
  })
  await load()
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" @click="router.push('/me')">‹</button>
      <h1>分类</h1>
    </div>
    <div class="card" style="margin-bottom: 12px">
      <div class="kind">
        <button class="expense" :class="{ on: kind === 'expense' }" @click="kind = 'expense'">支出</button>
        <button class="income" :class="{ on: kind === 'income' }" @click="kind = 'income'">收入</button>
      </div>
      <div class="inline">
        <input v-model="name" placeholder="例如 零食" @keyup.enter="add" />
        <button class="btn" style="width: auto" @click="add">添加</button>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
    </div>
    <div class="card" style="margin-bottom: 12px">
      <h2>支出</h2>
      <div class="row" v-for="c in grouped.expense" :key="c.id">
        <div>{{ c.name }} <span v-if="c.archived" class="muted">已归档</span></div>
        <button class="btn ghost" style="width: auto" @click="toggle(c)">{{ c.archived ? '恢复' : '归档' }}</button>
      </div>
    </div>
    <div class="card">
      <h2>收入</h2>
      <div class="row" v-for="c in grouped.income" :key="c.id">
        <div>{{ c.name }} <span v-if="c.archived" class="muted">已归档</span></div>
        <button class="btn ghost" style="width: auto" @click="toggle(c)">{{ c.archived ? '恢复' : '归档' }}</button>
      </div>
    </div>
  </div>
</template>
