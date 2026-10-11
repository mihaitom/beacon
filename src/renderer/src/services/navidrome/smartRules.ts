/**
 * Navidrome's smart playlist rules as an editable tree, and back.
 *
 * The JSON is Navidrome's own (its `model/criteria/`, summarised in
 * docs/plans/smart-playlist-builder.md). The editor understands only part of
 * it, and the rest has to survive a save untouched - those playlists may
 * have been written by hand, in an `.nsp` file or in another client. So a
 * rule this module cannot edit becomes an opaque node carrying its original
 * JSON, and every top-level key it does not use rides along as it came.
 */

export type Conjunction = 'all' | 'any'

export type Operator =
  | 'is'
  | 'isNot'
  | 'gt'
  | 'lt'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'inTheRange'
  | 'before'
  | 'after'
  | 'inTheLast'
  | 'notInTheLast'
  | 'inPlaylist'
  | 'notInPlaylist'
  | 'isMissing'
  | 'isPresent'

export type FieldKind = 'text' | 'number' | 'date' | 'boolean' | 'playlist'

/** What the field picker groups by. */
export type FieldTopic = 'song' | 'listening' | 'file'

export interface FieldDef {
  /** Navidrome's name for it, lower case as Navidrome compares them. */
  key: string
  kind: FieldKind
  topic: FieldTopic
  /** isMissing/isPresent work on it. Navidrome answers them with an error
   * on anything but a tag, an artist role or one of its nullable columns
   * (`missingExpr` in its `persistence/criteria_sql.go`). */
  presence: boolean
  /** Fewer operators than the kind offers, where the rest are no use. */
  operators?: readonly Operator[]
}

/** The fields the editor offers - a deliberate subset of Navidrome's ~70,
 * the ones people build playlists from. `playlist` is not a Navidrome field
 * but where inPlaylist/notInPlaylist live, whose value names a playlist. */
export const FIELDS: readonly FieldDef[] = [
  { key: 'title', kind: 'text', topic: 'song', presence: false },
  { key: 'artist', kind: 'text', topic: 'song', presence: true },
  { key: 'albumartist', kind: 'text', topic: 'song', presence: true },
  { key: 'album', kind: 'text', topic: 'song', presence: true },
  { key: 'genre', kind: 'text', topic: 'song', presence: true },
  { key: 'year', kind: 'number', topic: 'song', presence: false },
  { key: 'compilation', kind: 'boolean', topic: 'song', presence: false },
  { key: 'loved', kind: 'boolean', topic: 'listening', presence: false },
  { key: 'rating', kind: 'number', topic: 'listening', presence: false },
  { key: 'playcount', kind: 'number', topic: 'listening', presence: false },
  { key: 'lastplayed', kind: 'date', topic: 'listening', presence: false },
  { key: 'dateadded', kind: 'date', topic: 'listening', presence: false },
  { key: 'playlist', kind: 'playlist', topic: 'listening', presence: false },
  { key: 'duration', kind: 'number', topic: 'file', presence: false },
  { key: 'bpm', kind: 'number', topic: 'file', presence: true },
  // Matched whole: "contains mp" is no question anyone asks of a format.
  { key: 'filetype', kind: 'text', topic: 'file', presence: false, operators: ['is', 'isNot'] },
]

const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]))

export function fieldDef(key: string): FieldDef | undefined {
  return FIELD_BY_KEY.get(key)
}

const KIND_OPERATORS: Record<FieldKind, readonly Operator[]> = {
  text: ['contains', 'notContains', 'is', 'isNot', 'startsWith', 'endsWith'],
  number: ['is', 'isNot', 'gt', 'lt', 'inTheRange'],
  date: ['inTheLast', 'notInTheLast', 'before', 'after'],
  boolean: ['is'],
  playlist: ['inPlaylist', 'notInPlaylist'],
}

export function operatorsFor(field: FieldDef): Operator[] {
  return [
    ...(field.operators ?? KIND_OPERATORS[field.kind]),
    ...(field.presence ? (['isMissing', 'isPresent'] as const) : []),
  ]
}

/** Navidrome reads operator names case-insensitively. */
const OPERATOR_BY_LOWER = new Map(
  (
    [
      'is',
      'isNot',
      'gt',
      'lt',
      'contains',
      'notContains',
      'startsWith',
      'endsWith',
      'inTheRange',
      'before',
      'after',
      'inTheLast',
      'notInTheLast',
      'inPlaylist',
      'notInPlaylist',
      'isMissing',
      'isPresent',
    ] as const
  ).map((operator) => [operator.toLowerCase(), operator]),
)

/** Which control a rule's value needs, and which JSON shape it has. */
export type ValueShape =
  'text' | 'number' | 'range' | 'days' | 'date' | 'boolean' | 'playlist' | 'none'

export function valueShape(field: FieldDef, operator: Operator): ValueShape {
  if (operator === 'isMissing' || operator === 'isPresent') return 'none'
  switch (field.kind) {
    case 'text':
      return 'text'
    case 'number':
      return operator === 'inTheRange' ? 'range' : 'number'
    case 'date':
      return operator === 'inTheLast' || operator === 'notInTheLast' ? 'days' : 'date'
    case 'boolean':
      return 'boolean'
    case 'playlist':
      return 'playlist'
  }
}

/** A rule's value as the editor holds it. Null is "not filled in yet". */
export type RuleValue = string | number | boolean | [number | null, number | null] | null

export interface RuleNode {
  type: 'rule'
  /** Identity for the editor's lists; never saved. */
  key: number
  field: string
  operator: Operator
  value: RuleValue
}

/** A rule the editor cannot edit, kept exactly as it came. */
export interface OpaqueNode {
  type: 'opaque'
  key: number
  raw: unknown
}

/** The one level of grouping the editor offers under the top. */
export interface GroupNode {
  type: 'group'
  key: number
  conjunction: Conjunction
  children: (RuleNode | OpaqueNode)[]
}

export type TopNode = RuleNode | OpaqueNode | GroupNode

export type Sort =
  | { field: string; descending: boolean }
  /** A sort the editor cannot express (several fields, an unknown one),
   * with its `sort`/`order` entries under their original keys. */
  | { raw: Record<string, unknown> }
  | null

export interface SmartRules {
  conjunction: Conjunction
  children: TopNode[]
  sort: Sort
  limit: number | null
  /** Navidrome's duration string ("1d"), kept as written. */
  refreshDelay: string | null
  /** Every other top-level key (limitPercent, offset, ...), untouched. */
  extra: Record<string, unknown>
}

let lastKey = 0
function nextKey(): number {
  return ++lastKey
}

/** What can be sorted by: every field but the pseudo one, and random. */
export const SORT_FIELDS: readonly string[] = [
  ...FIELDS.filter((field) => field.kind !== 'playlist').map((field) => field.key),
  'random',
]

export function emptyRules(): SmartRules {
  return {
    conjunction: 'all',
    children: [],
    sort: null,
    limit: null,
    refreshDelay: null,
    extra: {},
  }
}

export function defaultValue(shape: ValueShape): RuleValue {
  switch (shape) {
    case 'text':
      return ''
    case 'range':
      return [null, null]
    case 'boolean':
      return true
    default:
      return null
  }
}

export function newRule(fieldKey = 'genre'): RuleNode {
  const field = fieldDef(fieldKey)!
  const operator = operatorsFor(field)[0]!
  return {
    type: 'rule',
    key: nextKey(),
    field: field.key,
    operator,
    value: defaultValue(valueShape(field, operator)),
  }
}

export function newGroup(conjunction: Conjunction = 'any'): GroupNode {
  return { type: 'group', key: nextKey(), conjunction, children: [newRule()] }
}

/** The rule with another field. The operator survives where the new field
 * has it too, and the value where it still has the same shape - switching
 * "artist contains Miles" to album keeps "contains Miles". */
export function withField(rule: RuleNode, fieldKey: string): RuleNode {
  const field = fieldDef(fieldKey)
  if (!field) return rule
  const operators = operatorsFor(field)
  const operator = operators.includes(rule.operator) ? rule.operator : operators[0]!
  return { ...rule, field: field.key, ...carriedValue(rule, field, operator), operator }
}

/** The rule with another operator, keeping the value where it fits. */
export function withOperator(rule: RuleNode, operator: Operator): RuleNode {
  const field = fieldDef(rule.field)
  if (!field || !operatorsFor(field).includes(operator)) return rule
  return { ...rule, operator, ...carriedValue(rule, field, operator) }
}

function carriedValue(rule: RuleNode, field: FieldDef, operator: Operator): { value: RuleValue } {
  const before = fieldDef(rule.field)
  const shape = valueShape(field, operator)
  const kept = before && valueShape(before, rule.operator) === shape
  return { value: kept ? rule.value : defaultValue(shape) }
}

// ── Reading ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The value in the editor's terms, or undefined when the JSON holds
 * something of another shape - which makes the whole rule opaque rather
 * than quietly changing it on the next save. */
function readValue(shape: ValueShape, value: unknown): RuleValue | undefined {
  switch (shape) {
    case 'text':
    case 'playlist':
      return typeof value === 'string' ? value : undefined
    case 'number':
      return isFiniteNumber(value) ? value : undefined
    case 'days':
      return isFiniteNumber(value) && value >= 0 ? value : undefined
    case 'range':
      return Array.isArray(value) &&
        value.length === 2 &&
        isFiniteNumber(value[0]) &&
        isFiniteNumber(value[1])
        ? [value[0], value[1]]
        : undefined
    case 'date':
      return typeof value === 'string' && DATE.test(value) ? value : undefined
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'none':
      // `false` would turn the operator around; nobody writes that on
      // purpose, and keeping it opaque is safer than guessing.
      return value === true ? null : undefined
  }
}

function opaque(raw: unknown): OpaqueNode {
  return { type: 'opaque', key: nextKey(), raw }
}

function readNode(raw: unknown, depth: number): TopNode {
  // Navidrome turns every key of one object into its own rule, so an
  // object holding two is two rules the editor would have to split - kept
  // whole instead.
  if (!isRecord(raw) || Object.keys(raw).length !== 1) return opaque(raw)
  const [name, inner] = Object.entries(raw)[0]!
  const lower = name.toLowerCase()

  if (lower === 'all' || lower === 'any') {
    if (depth > 0 || !Array.isArray(inner)) return opaque(raw)
    return {
      type: 'group',
      key: nextKey(),
      conjunction: lower,
      children: inner.map((child) => readNode(child, depth + 1) as RuleNode | OpaqueNode),
    }
  }

  const operator = OPERATOR_BY_LOWER.get(lower)
  if (!operator || !isRecord(inner) || Object.keys(inner).length !== 1) return opaque(raw)
  const [fieldName, value] = Object.entries(inner)[0]!

  // A playlist rule names the playlist under `id` rather than a field.
  const isPlaylistRule = operator === 'inPlaylist' || operator === 'notInPlaylist'
  const fieldKey = fieldName.toLowerCase()
  const field = isPlaylistRule
    ? fieldKey === 'id'
      ? fieldDef('playlist')
      : undefined
    : fieldDef(fieldKey)
  // The pseudo-field itself only takes the playlist operators, so
  // {"is": {"playlist": ...}} falls out here too.
  if (!field || !operatorsFor(field).includes(operator)) return opaque(raw)

  const parsed = readValue(valueShape(field, operator), value)
  if (parsed === undefined) return opaque(raw)
  return { type: 'rule', key: nextKey(), field: field.key, operator, value: parsed }
}

function readSort(sort: unknown, order: unknown): Sort {
  if (typeof sort !== 'string') return null
  const orderLower = typeof order === 'string' ? order.trim().toLowerCase() : ''
  const single = sort.trim()
  const match = /^([+-]?)\s*([a-z_]+)$/i.exec(single)
  if (!match || (orderLower !== '' && orderLower !== 'asc' && orderLower !== 'desc')) {
    return null
  }
  const field = match[2]!.toLowerCase()
  if (!SORT_FIELDS.includes(field)) return null
  // Navidrome flips a "-" field again when order is desc.
  return { field, descending: (match[1] === '-') !== (orderLower === 'desc') }
}

/** Navidrome's rules JSON as an editable tree. Anything other than an
 * object (a playlist without rules) gives an empty set. */
export function parseRules(json: unknown): SmartRules {
  const rules = emptyRules()
  if (!isRecord(json)) return rules

  let conjunctionKey: string | null = null
  let sortKey: string | null = null
  let orderKey: string | null = null
  // Go's JSON decoding matches these case-insensitively too.
  for (const [key, value] of Object.entries(json)) {
    const lower = key.toLowerCase()
    if ((lower === 'all' || lower === 'any') && conjunctionKey === null && Array.isArray(value)) {
      conjunctionKey = key
      rules.conjunction = lower
      rules.children = value.map((child) => readNode(child, 0))
    } else if (lower === 'sort' && sortKey === null) {
      sortKey = key
    } else if (lower === 'order' && orderKey === null) {
      orderKey = key
    } else if (lower === 'limit' && isFiniteNumber(value) && value >= 0) {
      rules.limit = value > 0 ? value : null
    } else if (lower === 'refreshdelay' && typeof value === 'string') {
      rules.refreshDelay = value
    } else {
      rules.extra[key] = value
    }
  }

  if (sortKey !== null || orderKey !== null) {
    const sort = sortKey !== null ? json[sortKey] : undefined
    const order = orderKey !== null ? json[orderKey] : undefined
    const parsed = readSort(sort, order)
    if (parsed) {
      rules.sort = parsed
    } else {
      const raw: Record<string, unknown> = {}
      if (sortKey !== null) raw[sortKey] = sort
      if (orderKey !== null) raw[orderKey] = order
      rules.sort = { raw }
    }
  }
  return rules
}

// ── Writing ─────────────────────────────────────────────────────────────

function writeValue(field: FieldDef, operator: Operator, value: RuleValue): unknown {
  return valueShape(field, operator) === 'none' ? true : value
}

function writeNode(node: TopNode): unknown {
  if (node.type === 'opaque') return node.raw
  if (node.type === 'group') return { [node.conjunction]: node.children.map(writeNode) }
  const field = fieldDef(node.field)!
  const name = field.kind === 'playlist' ? 'id' : field.key
  return { [node.operator]: { [name]: writeValue(field, node.operator, node.value) } }
}

/** The tree as Navidrome's rules JSON. Check `problems()` first: this
 * writes whatever is there, half-filled rules included. */
export function serializeRules(rules: SmartRules): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [rules.conjunction]: rules.children.map(writeNode),
  }
  if (rules.sort && 'raw' in rules.sort) Object.assign(out, rules.sort.raw)
  else if (rules.sort) out.sort = `${rules.sort.descending ? '-' : ''}${rules.sort.field}`
  if (rules.limit !== null) out.limit = rules.limit
  if (rules.refreshDelay !== null) out.refreshDelay = rules.refreshDelay
  return { ...out, ...rules.extra }
}

// ── Checking ────────────────────────────────────────────────────────────

export type Problem =
  { kind: 'noRules' } | { kind: 'emptyGroup'; key: number } | { kind: 'incomplete'; key: number }

function isComplete(rule: RuleNode): boolean {
  const field = fieldDef(rule.field)
  if (!field) return false
  const value = rule.value
  switch (valueShape(field, rule.operator)) {
    case 'text':
    case 'playlist':
      return typeof value === 'string' && value.trim() !== ''
    case 'number':
      return isFiniteNumber(value)
    case 'days':
      return isFiniteNumber(value) && value >= 0
    case 'range':
      return (
        Array.isArray(value) &&
        isFiniteNumber(value[0]) &&
        isFiniteNumber(value[1]) &&
        value[0] <= value[1]
      )
    case 'date':
      return typeof value === 'string' && DATE.test(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'none':
      return true
  }
}

/** What stands between these rules and a save Navidrome would accept. */
export function problems(rules: SmartRules): Problem[] {
  const found: Problem[] = []
  if (rules.children.length === 0) found.push({ kind: 'noRules' })
  const check = (node: TopNode) => {
    if (node.type === 'rule' && !isComplete(node)) found.push({ kind: 'incomplete', key: node.key })
    if (node.type === 'group') {
      if (node.children.length === 0) found.push({ kind: 'emptyGroup', key: node.key })
      node.children.forEach(check)
    }
  }
  rules.children.forEach(check)
  return found
}
