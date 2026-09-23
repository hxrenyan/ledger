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
    // 从 web-view 交接过来时会带 ledger_id（小程序当时的账本），优先采信，
    // 免得用户刚在原生页选好的账本一切到网页又跳回去。
    const preferred =
      body.ledger_id && body.ledgers.some((l) => l.id === body.ledger_id) ? body.ledger_id : ''
    if (preferred) {
      persistLedger(preferred)
    } else {
      const keep = body.ledgers.some((l) => l.id === ledgerId.value)
      persistLedger(keep ? ledgerId.value : (body.ledgers[0]?.id ?? ''))
    }
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
