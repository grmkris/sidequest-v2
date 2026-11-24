/** Alchemy's bundler inlines a `?raw` import as the file's text (alchemy/src/Bundle/RawPlugin.ts). */
declare module '*?raw' {
  const text: string
  export default text
}
