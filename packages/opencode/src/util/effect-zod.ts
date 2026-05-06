import { Schema, SchemaAST } from "effect"
import z from "zod"

export function zod<S extends Schema.Top>(schema: S): z.ZodType<Schema.Schema.Type<S>> {
  return walk(schema.ast) as z.ZodType<Schema.Schema.Type<S>>
}

function walk(ast: SchemaAST.AST): z.ZodTypeAny {
  const out = body(ast)
  const desc = SchemaAST.resolveDescription(ast)
  const ref = SchemaAST.resolveIdentifier(ast)
  const next = desc ? out.describe(desc) : out
  // `ref` propagates to JSON Schema as a non-standard `ref` keyword. The
  // hey-api/openapi-ts type generator uses it to emit named top-level
  // `export type` aliases (e.g. `QuestionInfo`, `QuestionRequest`). Without
  // it, those types collapse into anonymous inline shapes and our SDK
  // consumers can no longer import them.
  //
  // Caveat: OpenAI's Responses API rejects requests with `high|xhigh`
  // reasoning_effort when a tool schema contains the bare `ref` keyword
  // (deterministic `server_error` at SSE seq=3). The fix lives in the
  // outgoing request interceptor in `provider.ts` (`stripJsonSchemaRefs`)
  // — it walks `tools[*].parameters` and deletes any stray `ref` before
  // the body hits the wire. Keep both halves in sync.
  return ref ? next.meta({ ref }) : next
}

function body(ast: SchemaAST.AST): z.ZodTypeAny {
  if (SchemaAST.isOptional(ast)) return opt(ast)

  switch (ast._tag) {
    case "String":
      return z.string()
    case "Number":
      return z.number()
    case "Boolean":
      return z.boolean()
    case "Null":
      return z.null()
    case "Undefined":
      return z.undefined()
    case "Any":
    case "Unknown":
      return z.unknown()
    case "Never":
      return z.never()
    case "Literal":
      return z.literal(ast.literal)
    case "Union":
      return union(ast)
    case "Objects":
      return object(ast)
    case "Arrays":
      return array(ast)
    case "Declaration":
      return decl(ast)
    default:
      return fail(ast)
  }
}

function opt(ast: SchemaAST.AST): z.ZodTypeAny {
  if (ast._tag !== "Union") return fail(ast)
  const items = ast.types.filter((item) => item._tag !== "Undefined")
  if (items.length === 1) return walk(items[0]).optional()
  if (items.length > 1)
    return z.union(items.map(walk) as [z.ZodTypeAny, z.ZodTypeAny, ...Array<z.ZodTypeAny>]).optional()
  return z.undefined().optional()
}

function union(ast: SchemaAST.Union): z.ZodTypeAny {
  const items = ast.types.map(walk)
  if (items.length === 1) return items[0]
  if (items.length < 2) return fail(ast)

  const discriminator = (ast as any).annotations?.discriminator
  if (discriminator) {
    return z.discriminatedUnion(discriminator, items as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]])
  }

  return z.union(items as [z.ZodTypeAny, z.ZodTypeAny, ...Array<z.ZodTypeAny>])
}

function object(ast: SchemaAST.Objects): z.ZodTypeAny {
  if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1) {
    const sig = ast.indexSignatures[0]
    if (sig.parameter._tag !== "String") return fail(ast)
    return z.record(z.string(), walk(sig.type))
  }

  if (ast.indexSignatures.length > 0) return fail(ast)

  return z.object(Object.fromEntries(ast.propertySignatures.map((sig) => [String(sig.name), walk(sig.type)])))
}

function array(ast: SchemaAST.Arrays): z.ZodTypeAny {
  if (ast.elements.length > 0) return fail(ast)
  if (ast.rest.length !== 1) return fail(ast)
  return z.array(walk(ast.rest[0]))
}

function decl(ast: SchemaAST.Declaration): z.ZodTypeAny {
  if (ast.typeParameters.length !== 1) return fail(ast)
  return walk(ast.typeParameters[0])
}

function fail(ast: SchemaAST.AST): never {
  const ref = SchemaAST.resolveIdentifier(ast)
  throw new Error(`unsupported effect schema: ${ref ?? ast._tag}`)
}
