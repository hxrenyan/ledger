const key = (ledgerId: number) => `ledger.prefs.${ledgerId}`

export type Prefs = {
  accountId?: number
  expenseCat?: number
  incomeCat?: number
}

export function loadPrefs(ledgerId: number): Prefs {
  try {
    return JSON.parse(localStorage.getItem(key(ledgerId)) || '{}') as Prefs
  } catch {
    return {}
  }
}

export function savePrefs(ledgerId: number, patch: Prefs) {
  localStorage.setItem(key(ledgerId), JSON.stringify({ ...loadPrefs(ledgerId), ...patch }))
}
