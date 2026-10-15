<script setup lang="ts">
/** 工具清单只在网页里。往后加一项，重新发布服务即可，不用发小程序。 */
const tools = [{ to: '/tools/contacts', title: '联系人管理', desc: '就是人情里的那些人。在这里改姓名、关系和日子。' }]
</script>

<template>
  <h1>工具</h1>
  <div class="card">
    <router-link v-for="item in tools" :key="item.to" class="row" :to="item.to">
      <span>
        <strong>{{ item.title }}</strong>
        <span class="muted" style="display: block; margin-top: 4px">{{ item.desc }}</span>
      </span>
      <span class="muted">›</span>
    </router-link>
  </div>
</template>
