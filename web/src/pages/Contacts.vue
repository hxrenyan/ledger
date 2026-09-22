<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api.ts'
import { formatYuan } from '../money.ts'

type Contact = {
  id: string
  name: string
  relation: string
  archived: boolean
  given_cents: number
  received_cents: number
  net_cents: number
}

const router = useRouter()
const items = ref<Contact[]>([])
const name = ref('')
const relation = ref('')
const err = ref('')
const adding = ref(false)

const visible = computed(() => items.value.filter((c) => !c.archived))

async function load() {
  err.value = ''
  items.value = (await api<{ items: Contact[] }>('/api/v1/contacts')).items
}

async function add() {
  err.value = ''
  if (!name.value.trim()) {
    err.value = '请填写姓名'
    return
  }
  adding.value = true
  try {
    await api('/api/v1/contacts', {
      method: 'POST',
      body: JSON.stringify({ name: name.value, relation: relation.value }),
    })
    name.value = ''
    relation.value = ''
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '添加失败'
  } finally {
    adding.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" @click="router.push('/favors')">‹</button>
      <h1>联系人</h1>
    </div>
    <div class="card" style="margin-bottom: 12px">
      <div class="inline">
        <input v-model="name" placeholder="姓名" @keyup.enter="add" />
        <input v-model="relation" class="slim" placeholder="关系" @keyup.enter="add" />
        <button class="btn" style="width: auto" :disabled="adding" @click="add">添加</button>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
    </div>
    <div v-if="!visible.length" class="card muted">还没有人。加了之后，记人情时下拉选择。</div>
    <div v-else class="card">
      <div class="row" v-for="c in visible" :key="c.id" @click="router.push(`/favors/person/${c.id}`)">
        <div>
          <div>{{ c.name }} <span v-if="c.relation" class="muted">{{ c.relation }}</span></div>
          <div class="muted">送 {{ formatYuan(c.given_cents) }} · 收 {{ formatYuan(c.received_cents) }}</div>
        </div>
        <div class="amount" :class="c.net_cents >= 0 ? 'income' : 'expense'">
          {{ c.net_cents >= 0 ? '+' : '' }}{{ formatYuan(c.net_cents) }}
        </div>
      </div>
    </div>
  </div>
</template>
