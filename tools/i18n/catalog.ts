import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'

export type Catalog = Readonly<Record<string, string>>
export type ArgumentKind = 'text' | 'number' | 'date' | 'tag'
export type Contract = ReadonlyMap<string, ArgumentKind>

// Optional messages can be listed here when a reviewed catalog intentionally contains an empty value.
const optionalCopy = new Set<string>()

export const flatten = (input: unknown, prefix = ''): Catalog => {
  if (typeof input === 'string') {
    if (!input.trim() && !(input === '' && optionalCopy.has(prefix))) throw new Error(`Empty message: ${prefix}`)
    return { [prefix]: input }
  }
  if (typeof input !== 'object' || input === null) throw new Error(`Invalid catalog node: ${prefix}`)
  const output: Record<string, string> = {}
  for (const [key, child] of Object.entries(input)) {
    if (key.includes('.')) throw new Error(`Dotted catalog segment: ${key}`)
    Object.assign(output, flatten(child, prefix ? `${prefix}.${key}` : key))
  }
  return output
}

// Exact reviewed-copy waivers preserve intentional wording while rejecting new missing plural forms.
const pluralWaivers: Readonly<Record<string, string>> = {}

const compatible = (left: ArgumentKind, right: ArgumentKind): ArgumentKind => {
  if (left === right) return left
  if (left === 'text' && right === 'number') return right
  if (left === 'number' && right === 'text') return left
  throw new Error(`Incompatible ICU argument types: ${left}/${right}`)
}

const argumentKind = (node: MessageFormatElement): ArgumentKind | undefined => {
  switch (node.type) {
    case TYPE.literal:
    case TYPE.pound:
      return undefined
    case TYPE.argument:
    case TYPE.select:
      return 'text'
    case TYPE.number:
    case TYPE.plural:
      return 'number'
    case TYPE.date:
    case TYPE.time:
      return 'date'
    case TYPE.tag:
      return 'tag'
  }
}

const visit = function* (nodes: readonly MessageFormatElement[]): Generator<MessageFormatElement> {
  for (const node of nodes) {
    yield node
    if (node.type === TYPE.tag) yield* visit(node.children)
    if (node.type === TYPE.select || node.type === TYPE.plural)
      for (const option of Object.values(node.options)) yield* visit(option.value)
  }
}

const checkPlural = (locale: string, key: string, message: string, node: MessageFormatElement): void => {
  if (node.type !== TYPE.plural) return
  const categories = new Intl.PluralRules(locale, { type: node.pluralType }).resolvedOptions().pluralCategories
  const missing = categories.filter((category) => !(category in node.options))
  const waiver = `${locale}:${key}:${node.value}:${missing.join(',')}`
  if (missing.length && pluralWaivers[waiver] !== message) throw new Error(`Missing plural forms: ${waiver}`)
}

export const contractFor = (locale: string, key: string, message: string): Contract => {
  const contract = new Map<string, ArgumentKind>()
  for (const node of visit(parse(message, { locale: new Intl.Locale(locale) }))) {
    const kind = argumentKind(node)
    if (kind !== undefined && 'value' in node) {
      const previous = contract.get(node.value)
      contract.set(node.value, previous === undefined ? kind : compatible(kind, previous))
    }
    if (node.type === TYPE.tag && node.value !== 'italic')
      throw new Error(`Unapproved rich tag in ${locale}:${key}: ${node.value}`)
    checkPlural(locale, key, message, node)
  }
  return contract
}

export const validateCatalogs = (en: Catalog, sl: Catalog): ReadonlyMap<string, Contract> => {
  const keys = Object.keys(en).toSorted()
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(sl).toSorted())) throw new Error('Catalog key parity failed')
  const contracts = new Map<string, Contract>()
  for (const key of keys) {
    const source = en[key]
    const target = sl[key]
    if (source === undefined || target === undefined) throw new Error(`Missing message: ${key}`)
    const left = contractFor('en', key, source)
    const right = contractFor('sl', key, target)
    if (JSON.stringify([...left.keys()].toSorted()) !== JSON.stringify([...right.keys()].toSorted()))
      throw new Error(`Argument parity failed: ${key}`)
    const merged = new Map<string, ArgumentKind>()
    for (const [name, kind] of left) {
      const other = right.get(name)
      if (other === undefined) throw new Error(`Missing argument: ${key}:${name}`)
      merged.set(name, compatible(kind, other))
    }
    contracts.set(key, merged)
  }
  return contracts
}
