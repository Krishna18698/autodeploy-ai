<script setup lang="ts">
// Rendered on the server for every request (and hydrated in the browser).
const { data: now } = await useAsyncData('now', () => Promise.resolve(new Date().toISOString()));
</script>

<template>
  <h1>e2e nuxt ok at {{ now }}</h1>
</template>
