/**
 * A small OpenAPI 3.0 to TypeScript and Python emitter, with no dependencies.
 *
 * It covers what the SC Market and SC Orgs specs use (tsoa output): objects,
 * arrays, enums, nullable, $ref, allOf/anyOf/oneOf and additionalProperties.
 * Anything it doesn't understand becomes `unknown` / `Any`, never an error.
 *
 * Shared by sc-market-sdk and sc-orgs-sdk: keep the two copies identical.
 */

const TS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const PY_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
])

/** A schema name as an identifier: `Record_string.unknown_` -> `Record_string_unknown_`. */
export const ident = (name) => name.replace(/[^A-Za-z0-9_]/g, "_")
export const refName = (ref) => ident(ref.split("/").pop())
const pascal = (s) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("")
export const camel = (s) => {
  const p = pascal(s)
  return p[0].toLowerCase() + p.slice(1)
}
export const snake = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
export const pySafe = (name) => {
  const s = snake(name)
  return PY_KEYWORDS.has(s) ? `${s}_` : s
}

/** Every schema reachable from `roots` (names), following $ref. */
export function reachableSchemas(schemas, roots) {
  const seen = new Set()
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== "object") return
    if (typeof node.$ref === "string") {
      const name = node.$ref.split("/").pop()
      if (!seen.has(name) && schemas[name]) {
        seen.add(name)
        visit(schemas[name])
      }
    }
    for (const v of Object.values(node)) visit(v)
  }
  for (const r of roots) visit({ $ref: `#/components/schemas/${r}` })
  return Object.fromEntries(Object.keys(schemas).filter((n) => seen.has(n)).map((n) => [n, schemas[n]]))
}

function deref(spec, schema) {
  let s = schema
  for (let i = 0; s && s.$ref && i < 20; i++) s = spec.components.schemas[s.$ref.split("/").pop()]
  // tsoa writes `allOf: [ $ref ]` for a nullable reference.
  if (s && s.allOf && s.allOf.length === 1) return deref(spec, s.allOf[0])
  return s
}

// ─── Operations ─────────────────────────────────────────────────────────────

/**
 * The spec's operations in a generator-friendly form. `result` is the 200
 * response's `data` (both APIs wrap every success in `{ "data": … }`);
 * `page` is set for list operations that take `page` and return
 * `{ <items>: [], total, page, page_size }`.
 */
export function operations(spec) {
  const out = []
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
      const pathParams = params.filter((p) => p.in === "path")
      // Path parameters in the order they appear in the path.
      pathParams.sort((a, b) => path.indexOf(`{${a.name}}`) - path.indexOf(`{${b.name}}`))
      const queryParams = params.filter((p) => p.in === "query")
      const ok = op.responses?.["200"] ?? op.responses?.["201"]
      let result = ok?.content?.["application/json"]?.schema ?? null
      const envelope = result ? deref(spec, result) : null
      if (envelope?.properties?.data) result = envelope.properties.data
      const body = op.requestBody?.content?.["application/json"]?.schema ?? null
      const security = op.security ?? spec.security ?? []
      const scopes = [...new Set(security.flatMap((s) => Object.values(s).flat()))]
      const authOptional = security.length === 0 || security.some((s) => Object.keys(s).length === 0)

      let page = null
      const data = result ? deref(spec, result) : null
      if (queryParams.some((p) => p.name === "page") && data?.properties) {
        const req = new Set(data.required ?? [])
        const arrays = Object.entries(data.properties).filter(([, v]) => deref(spec, v)?.type === "array")
        if (arrays.length === 1 && ["total", "page", "page_size"].every((k) => req.has(k))) {
          const [key, arr] = arrays[0]
          page = { key, item: deref(spec, arr).items }
        }
      }
      out.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? "",
        description: op.description ?? "",
        deprecated: !!op.deprecated,
        pathParams,
        queryParams,
        body,
        bodyRequired: !!op.requestBody?.required,
        result,
        page,
        scopes,
        authOptional,
      })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** `ListShopListings` -> `ShopListings`; `GetListingStock` -> `ListingStock`. */
export const iteratorStem = (id) => id.replace(/^(List|Get|Search)/, "") || id

// ─── TypeScript ─────────────────────────────────────────────────────────────

const tsKey = (k) => (TS_IDENT.test(k) ? k : JSON.stringify(k))
const paren = (t) => (/[|&]/.test(t) && !/^\{[\s\S]*\}$/.test(t) ? `(${t})` : t)

function tsDoc(text, indent) {
  if (!text) return ""
  const lines = String(text).replace(/\*\//g, "*\\/").split("\n")
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.trimEnd()).join("\n")}\n${indent} */\n`
}

export function tsType(schema, indent = "", prefix = "") {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) return "unknown"
  let t
  if (schema.$ref) t = prefix + refName(schema.$ref)
  else if (schema.allOf) t = schema.allOf.map((s) => paren(tsType(s, indent, prefix))).join(" & ")
  else if (schema.anyOf || schema.oneOf) t = (schema.anyOf ?? schema.oneOf).map((s) => paren(tsType(s, indent, prefix))).join(" | ")
  else if (schema.enum) t = schema.enum.map((v) => (v === null ? "null" : JSON.stringify(v))).join(" | ")
  else if (schema.type === "string") t = "string"
  else if (schema.type === "number" || schema.type === "integer") t = "number"
  else if (schema.type === "boolean") t = "boolean"
  else if (schema.type === "array") t = `Array<${tsType(schema.items, indent, prefix)}>`
  else if (schema.type === "object" || schema.properties || schema.additionalProperties) t = tsObject(schema, indent, prefix)
  else t = "unknown"
  if (schema.nullable && t !== "unknown") t = `${paren(t)} | null`
  return t
}

function tsObject(schema, indent, prefix) {
  const props = schema.properties ?? {}
  const keys = Object.keys(props)
  const ap = schema.additionalProperties
  if (keys.length === 0) {
    if (ap && typeof ap === "object" && Object.keys(ap).length) return `Record<string, ${tsType(ap, indent, prefix)}>`
    return "Record<string, unknown>"
  }
  const req = new Set(schema.required ?? [])
  const inner = `${indent}  `
  const lines = keys.map(
    (k) => `${tsDoc(props[k].description, inner)}${inner}${tsKey(k)}${req.has(k) ? "" : "?"}: ${tsType(props[k], inner, prefix)}`,
  )
  if (ap === true || (ap && typeof ap === "object")) lines.push(`${inner}[key: string]: unknown`)
  return `{\n${lines.join("\n")}\n${indent}}`
}

/** `export interface …` / `export type …` for every schema. */
export function tsSchemas(schemas, header) {
  const parts = [header]
  for (const [name, schema] of Object.entries(schemas)) {
    const id = ident(name)
    const doc = tsDoc(schema.description, "")
    const isInterface = schema.properties && Object.keys(schema.properties).length && !schema.nullable && !schema.allOf && !schema.anyOf && !schema.oneOf
    parts.push(isInterface ? `${doc}export interface ${id} ${tsObject(schema, "", "")}\n` : `${doc}export type ${id} = ${tsType(schema, "", "")}\n`)
  }
  return parts.join("\n")
}

/**
 * The generated client class: one method per operation, plus an
 * `iterate…` async generator for each paginated list.
 */
export function tsOperations(spec, { className, baseImport, header }) {
  const ops = operations(spec)
  const lines = [header, `import { BaseClient, type RequestOptions } from "${baseImport}"`, `import type * as T from "./types.js"`, ""]
  for (const op of ops) {
    if (!op.queryParams.length) continue
    lines.push(`/** Query parameters of ${op.id}. */`, `export interface ${op.id}Query {`)
    for (const p of op.queryParams) {
      lines.push(`${tsDoc(p.description, "  ")}  ${tsKey(p.name)}${p.required ? "" : "?"}: ${tsType(p.schema, "  ", "T.")}`)
    }
    lines.push("}", "")
  }
  lines.push(
    `/** Generated from the OpenAPI spec: one method per operation. Extend it, don't edit it. */`,
    `export abstract class ${className} extends BaseClient {`,
  )
  for (const op of ops) {
    const name = camel(op.id)
    const resultType = op.result ? tsType(op.result, "  ", "T.") : "unknown"
    const args = op.pathParams.map((p) => `${camel(p.name)}: string`)
    const queryRequired = op.queryParams.some((p) => p.required)
    if (op.body) args.push(`body${op.bodyRequired ? "" : "?"}: ${tsType(op.body, "  ", "T.")}`)
    if (op.queryParams.length) args.push(`query${queryRequired ? "" : "?"}: ${op.id}Query`)
    args.push("options?: RequestOptions")
    const urlPath = op.path.replace(/\{([^}]+)\}/g, (_, n) => `\${encodeURIComponent(${camel(n)})}`)
    const reqOpts = [op.queryParams.length ? "query" : null, op.body ? "body" : null, "...options"].filter(Boolean).join(", ")
    const docLines = [op.summary, "", op.description && op.description !== op.summary ? op.description : "", ""]
    docLines.push(`\`${op.method} ${op.path}\` (${op.id})`)
    if (op.scopes.length) docLines.push(`Scopes: ${op.scopes.join(", ")}${op.authOptional ? " (a key is optional: without one you get the public view)" : ""}`)
    else if (op.authOptional) docLines.push("No key needed.")
    if (op.deprecated) docLines.push("@deprecated")
    lines.push(tsDoc(docLines.filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n").trim(), "  ").trimEnd())
    lines.push(`  ${name}(${args.join(", ")}): Promise<${resultType}> {`)
    lines.push(`    return this.request<${resultType}>("${op.method}", \`${urlPath}\`, { ${reqOpts} })`)
    lines.push("  }", "")
    if (op.page) {
      const itemType = tsType(op.page.item, "  ", "T.")
      const iterArgs = op.pathParams.map((p) => `${camel(p.name)}: string`)
      iterArgs.push(`query${queryRequired ? "" : "?"}: Omit<${op.id}Query, "page">`, "options?: RequestOptions")
      const callArgs = op.pathParams.map((p) => camel(p.name))
      callArgs.push("{ ...query, page_size: query?.page_size ?? 100, page }", "options")
      lines.push(
        tsDoc(`Every item of ${name}(), page by page (100 per request unless you set page_size).\nStops after the last page; each page is one request against your rate limit.`, "  ").trimEnd(),
        `  iterate${iteratorStem(op.id)}(${iterArgs.join(", ")}): AsyncGenerator<${itemType}> {`,
        `    return this.paginate((page) => this.${name}(${callArgs.join(", ")}), "${op.page.key}")`,
        "  }",
        "",
      )
    }
  }
  if (lines[lines.length - 1] === "") lines.pop()
  lines.push("}", "")
  return lines.join("\n")
}

// ─── Python ─────────────────────────────────────────────────────────────────

class PyEmitter {
  constructor(schemas) {
    this.schemas = schemas
    this.extra = [] // nested TypedDicts for inline objects, emitted before their parent
  }

  type(schema, hint) {
    if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) return "Any"
    let t
    if (schema.$ref) t = `"${refName(schema.$ref)}"`
    else if (schema.allOf) t = schema.allOf.length === 1 ? this.type(schema.allOf[0], hint) : "Dict[str, Any]"
    else if (schema.anyOf || schema.oneOf) t = `Union[${(schema.anyOf ?? schema.oneOf).map((s, i) => this.type(s, `${hint}${i}`)).join(", ")}]`
    else if (schema.enum) t = `Literal[${schema.enum.map((v) => (v === null ? "None" : JSON.stringify(v))).join(", ")}]`
    else if (schema.type === "string") t = "str"
    else if (schema.type === "integer") t = "int"
    else if (schema.type === "number") t = "float"
    else if (schema.type === "boolean") t = "bool"
    else if (schema.type === "array") t = `List[${this.type(schema.items, `${hint}Item`)}]`
    else if (schema.properties && Object.keys(schema.properties).length) {
      this.extra.push(this.typedDict(hint, schema))
      t = `"${hint}"`
    } else if (schema.type === "object" || schema.additionalProperties) {
      const ap = schema.additionalProperties
      t = ap && typeof ap === "object" && Object.keys(ap).length ? `Dict[str, ${this.type(ap, `${hint}Value`)}]` : "Dict[str, Any]"
    } else t = "Any"
    if (schema.nullable && t !== "Any") t = `Optional[${t}]`
    return t
  }

  typedDict(name, schema) {
    const props = schema.properties ?? {}
    const req = new Set(schema.required ?? [])
    const fields = Object.entries(props).map(([k, v]) => ({ k, t: this.type(v, `${name}${pascal(k)}`), required: req.has(k), doc: v.description }))
    const doc = schema.description ? `    """${String(schema.description).replace(/"""/g, "'''").replace(/\\/g, "\\\\")}"""\n` : ""
    if (fields.some((f) => !PY_IDENT.test(f.k) || PY_KEYWORDS.has(f.k))) {
      // Functional syntax for keys that aren't identifiers; every key optional.
      const body = fields.map((f) => `    ${JSON.stringify(f.k)}: ${f.t},`).join("\n")
      return `${name} = TypedDict(\n    "${name}",\n    {\n${body}\n    },\n    total=False,\n)\n`
    }
    const field = (f) => `${f.doc ? `    #: ${String(f.doc).split("\n")[0]}\n` : ""}    ${f.k}: ${f.t}`
    const required = fields.filter((f) => f.required)
    const optional = fields.filter((f) => !f.required)
    if (!optional.length) return `class ${name}(TypedDict):\n${doc}${required.map(field).join("\n") || "    pass"}\n`
    if (!required.length) return `class ${name}(TypedDict, total=False):\n${doc}${optional.map(field).join("\n")}\n`
    return `class _${name}Required(TypedDict):\n${required.map(field).join("\n")}\n\n\nclass ${name}(_${name}Required, total=False):\n${doc}${optional.map(field).join("\n")}\n`
  }
}

export function pySchemas(schemas, header) {
  const em = new PyEmitter(schemas)
  const blocks = []
  const names = []
  for (const [raw, schema] of Object.entries(schemas)) {
    const name = ident(raw)
    names.push(name)
    em.extra = []
    let block
    if (schema.properties && Object.keys(schema.properties).length && !schema.nullable && !schema.allOf && !schema.anyOf && !schema.oneOf) block = em.typedDict(name, schema)
    else block = `${name} = ${em.type(schema, name)}\n`
    blocks.push(...em.extra, block)
  }
  return [
    header,
    "from typing import Any, Dict, List, Optional, Union",
    "",
    "try:",
    "    from typing import Literal, TypedDict",
    "except ImportError:  # pragma: no cover",
    "    from typing_extensions import Literal, TypedDict  # type: ignore",
    "",
    "",
    blocks.join("\n\n"),
    `__all__ = [${names.map((n) => JSON.stringify(n)).join(", ")}]`,
    "",
  ].join("\n")
}

export function pyOperations(spec, { className, header }) {
  const ops = operations(spec)
  const em = new PyEmitter(spec.components.schemas)
  const lines = [
    header,
    "from typing import Any, Dict, Iterator, List, Optional, Union",
    "",
    "from ._http import BaseClient",
    "from . import _types as T  # noqa: F401  (names used in string annotations)",
    "from ._types import *  # noqa: F401,F403",
    "",
    "try:",
    "    from typing import Literal",
    "except ImportError:  # pragma: no cover",
    "    from typing_extensions import Literal  # type: ignore",
    "",
    "",
    `class ${className}(BaseClient):`,
    '    """Generated from the OpenAPI spec: one method per operation."""',
    "",
  ]
  const pyDoc = (text) => {
    const body = String(text).replace(/\\/g, "\\\\").replace(/"""/g, "'''")
    return `        """${body.split("\n").map((l, i) => (i === 0 || !l ? l : `        ${l}`)).join("\n")}\n        """`
  }
  for (const op of ops) {
    const name = snake(op.id)
    const result = op.result ? em.type(op.result, `${op.id}Result`) : "Any"
    const sig = ["self", ...op.pathParams.map((p) => `${pySafe(p.name)}: str`)]
    if (op.body) sig.push(`body: ${em.type(op.body, `${op.id}Body`)}${op.bodyRequired ? "" : " = None"}`)
    const kw = op.queryParams.map((p) => `${pySafe(p.name)}: ${p.required ? em.type(p.schema, "Any") : `Optional[${em.type(p.schema, "Any")}] = None`}`)
    if (kw.length) sig.push("*", ...kw)
    const urlPath = op.path.replace(/\{([^}]+)\}/g, (_, n) => `{_q(${pySafe(n)})}`)
    const query = op.queryParams.length ? `{${op.queryParams.map((p) => `${JSON.stringify(p.name)}: ${pySafe(p.name)}`).join(", ")}}` : "None"
    const doc = [op.summary, "", op.description && op.description !== op.summary ? op.description : "", "", `${op.method} ${op.path} (${op.id})`]
    if (op.scopes.length) doc.push(`Scopes: ${op.scopes.join(", ")}${op.authOptional ? " (a key is optional)" : ""}`)
    lines.push(`    def ${name}(${sig.join(", ")}) -> ${result}:`, pyDoc(doc.filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n").trim()))
    lines.push(`        return self._request(${JSON.stringify(op.method)}, f"${urlPath}", query=${query}${op.body ? ", body=body" : ""})`, "")
    if (op.page) {
      const item = em.type(op.page.item, `${op.id}Item`)
      const isig = ["self", ...op.pathParams.map((p) => `${pySafe(p.name)}: str`)]
      const ikw = op.queryParams.filter((p) => p.name !== "page").map((p) => (p.name === "page_size" ? "page_size: int = 100" : `${pySafe(p.name)}: Optional[${em.type(p.schema, "Any")}] = None`))
      if (ikw.length) isig.push("*", ...ikw)
      const call = [
        ...op.pathParams.map((p) => pySafe(p.name)),
        ...op.queryParams.filter((p) => p.name !== "page").map((p) => `${pySafe(p.name)}=${pySafe(p.name)}`),
        "page=page",
      ]
      lines.push(
        `    def iter_${snake(iteratorStem(op.id))}(${isig.join(", ")}) -> Iterator[${item}]:`,
        pyDoc(`Every item of ${name}(), page by page (100 per request by default).`),
        `        return self._paginate(lambda page: self.${name}(${call.join(", ")}), ${JSON.stringify(op.page.key)})`,
        "",
      )
    }
  }
  if (em.extra.length) {
    // Inline object types used only by operations (rare).
    lines.splice(lines.indexOf(`class ${className}(BaseClient):`), 0, ...em.extra.map((b) => `${b}\n`))
  }
  lines.push(
    "",
    "def _q(value: str) -> str:",
    "    from urllib.parse import quote",
    "",
    '    return quote(str(value), safe="")',
    "",
  )
  return lines.join("\n")
}
