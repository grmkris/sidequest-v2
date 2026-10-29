import { checkGraph } from './quality/graph.ts'

const result = await checkGraph()
console.log(`Graph: ${result.files} files; ${result.browserModules} browser modules; boundaries satisfied`)
