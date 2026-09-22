<script setup lang="ts">
import { useSession } from '../stores/session.ts'

const session = useSession()
</script>

<template>
  <span v-if="session.ledgers.length > 1" class="ledger-now">{{ session.currentLedger?.name }}</span>
</template>
