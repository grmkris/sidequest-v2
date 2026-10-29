import { defineConfig } from 'zyzz'

export const { style, vars } = defineConfig({
  id: 'sidequest',
  output: 'html',
  vars: {
    color: {
      paper: '#f6f7f9',
      stock: '#ffffff',
      ink: '#17202a',
      ink2: '#53606d',
      onInk: '#ffffff',
      signal: '#3458d4',
      rule: '#d8dee8',
      focus: '#3458d4',
    },
    fontFamily: { body: 'Inter, system-ui, sans-serif' },
    radius: { panel: '18px', pill: '999px' },
  },
})
