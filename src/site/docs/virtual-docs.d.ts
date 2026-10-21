// The module build/plugin.ts generates from docs/site.json and docs/*.md.
declare module 'virtual:handset-docs' {
  export const sections: import('./types').DocsSection[]
  export const bodies: Record<string, import('./types').DocsBody>
}
