import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Ledger, SessionBody } from '../api.ts'

function readLedgers(): Ledger[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEDGERS) ?? '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

const TOKEN = 'ledger.token'
const LEDGER = 'ledger.id'
const USER = 'ledger.user'
const LEDGERS = 'ledger.ledgers'

export const useSession = defineStore('session', () => {
  const token = ref(localStorage.getItem(TOKEN) ?? '')
  const ledgerId = ref(localStorage.getItem(LEDGER) ?? '')
  const user = ref<{ id: string; username: string; nickname: string } | null>(
    JSON.parse(localStorage.getItem(USER) ?? 'null'),
  )
  const ledgers = ref<Ledger[]>(readLedgers())

  const currentLedger = computed(() => ledgers.value.find((l) => l.id === ledgerId.value) ?? ledgers.value[0] ?? null)

  function persistLedger(id: string) {
    ledgerId.value = id
    localStorage.setItem(LEDGER, id)
  }

  function apply(body: SessionBody) {
    token.value = body.token
    user.value = body.user
    ledgers.value = body.ledgers
    const keep = body.ledgers.some((l) => l.id === ledgerId.value)
    persistLedger(keep ? ledgerId.value : (body.ledgers[0]?.id ?? ''))
    localStorage.setItem(TOKEN, body.token)
    localStorage.setItem(USER, JSON.stringify(body.user))
    localStorage.setItem(LEDGERS, JSON.stringify(body.ledgers))
  }

  function setLedger(id: string) {
    persistLedger(id)
  }

  function clear() {
    token.value = ''
    ledgerId.value = ''
    user.value = null
    ledgers.value = []
    localStorage.removeItem(TOKEN)
    localStorage.removeItem(LEDGER)
    localStorage.removeItem(USER)
    localStorage.removeItem(LEDGERS)
  }

  return { token, ledgerId, user, ledgers, currentLedger, apply, setLedger, clear }
})
