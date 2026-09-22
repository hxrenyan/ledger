/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// 注意：不要再给 '@server/*' 加 `declare module` 的影子声明。
// web/tsconfig.json 里已有 paths 映射，影子声明会盖住真实解析（曾导致 @server/time.ts 全部报“无导出成员”）。
