const key = (ledgerId: string) => `ledger.prefs.${ledgerId}`

export type Prefs = {
  accountId?: string
  expenseCat?: string
  incomeCat?: string
}

export function loadPrefs(ledgerId: string): Prefs {
  try {
    return JSON.parse(localStorage.getItem(key(ledgerId)) || '{}') as Prefs
  } catch {
    return {}
  }
}

export function savePrefs(ledgerId: string, patch: Prefs) {
  localStorage.setItem(key(ledgerId), JSON.stringify({ ...loadPrefs(ledgerId), ...patch }))
}
