import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state"
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view"

const max = 2_000

export type Hit = {
  from: number
  to: number
}

type State = {
  query: string
  active: number
  deco: DecorationSet
}

export const set = StateEffect.define<{ query: string; active: number }>()

const mark = Decoration.mark({ class: "cm-ocSearchMatch" })
const active = Decoration.mark({ class: "cm-ocSearchMatch cm-ocSearchMatchActive" })

function payload(effect: StateEffect<unknown>) {
  if (!effect.is(set)) return
  return effect.value
}

export function ranges(text: string, query: string): Hit[] {
  const term = query.trim()
  if (!term) return []

  const hay = text.toLowerCase()
  const needle = term.toLowerCase()
  const res: Hit[] = []
  let idx = hay.indexOf(needle)
  while (idx >= 0 && res.length < max) {
    res.push({ from: idx, to: idx + needle.length })
    idx = hay.indexOf(needle, idx + needle.length)
  }
  return res
}

function build(text: string, query: string, current: number) {
  const builder = new RangeSetBuilder<Decoration>()
  ranges(text, query).forEach((hit, idx) => {
    builder.add(hit.from, hit.to, idx === current ? active : mark)
  })
  return builder.finish()
}

export const extension = StateField.define<State>({
  create() {
    return { query: "", active: 0, deco: Decoration.none }
  },
  update(value, tr) {
    const next = tr.effects.map(payload).find((item) => item)
    const query = next?.query ?? value.query
    const current = next?.active ?? value.active
    if (!next && !tr.docChanged) return value
    return {
      query,
      active: current,
      deco: build(tr.state.doc.toString(), query, current),
    }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})
