import { describe, expect, test } from "bun:test"
import { apply, decode, empty, render, track } from "../src/notes.ts"

describe("notes", () => {
  test("adds, updates and removes items by 1-based number", () => {
    const added = apply(empty(), { action: "add", section: "findings", text: "  BP_Civvy's parent class was deleted  " }, 1500)
    if (!("notes" in added)) throw new Error(added.error)
    expect(added.notes.findings).toEqual(["BP_Civvy's parent class was deleted"])
    const updated = apply(added.notes, { action: "update", section: "findings", index: 1, text: "Parent class removed in August" }, 1500)
    if (!("notes" in updated)) throw new Error(updated.error)
    expect(render(updated.notes)).toContain("1. Parent class removed in August")
    const removed = apply(updated.notes, { action: "remove", section: "findings", index: 1 }, 1500)
    if (!("notes" in removed)) throw new Error(removed.error)
    expect(removed.notes.findings).toEqual([])
    expect(apply(removed.notes, { action: "remove", section: "findings", index: 1 }, 1500)).toEqual({
      error: "findings has no item 1; it has 0.",
    })
  })

  test("refuses additions past the budget but always allows removal", () => {
    const long = "x".repeat(400)
    const full = [1, 2, 3].reduce(
      (notes) => {
        const next = apply(notes, { action: "add", section: "decisions", text: long }, 400)
        return "notes" in next ? next.notes : notes
      },
      empty(),
    )
    const refused = apply(full, { action: "add", section: "decisions", text: long }, 400)
    expect("error" in refused && refused.error).toContain("over the 400-token budget")
    expect("notes" in apply(full, { action: "remove", section: "decisions", index: 1 }, 10)).toBe(true)
  })

  test("tracks changed files without repeats, newest last", () => {
    const notes = ["edited a.ts", "wrote b.ts", "edited a.ts"].reduce(track, empty())
    expect(notes.changed).toEqual(["wrote b.ts", "edited a.ts"])
  })

  test("reads saved notes and drops malformed fields", () => {
    expect(decode({ task: "Fix patrol", findings: ["ok", 3, null], open: "not a list" })).toEqual({
      ...empty(),
      task: "Fix patrol",
      findings: ["ok"],
    })
    expect(decode(null)).toEqual(empty())
  })
})
