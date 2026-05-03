import { describe, expect, test } from "bun:test"
import { createContext, useContext, type ParentProps } from "solid-js"
import { render } from "solid-js/web"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"

const SessionContext = createContext("missing")

function SessionProvider(props: ParentProps) {
  return <SessionContext.Provider value="session-owned">{props.children}</SessionContext.Provider>
}

function DialogLauncher() {
  const dialog = useDialog()
  const value = useContext(SessionContext)

  return (
    <button
      type="button"
      onClick={() => {
        dialog.show(() => (
          <Dialog title="Owner regression">
            <div data-testid="owner-value">{value}</div>
          </Dialog>
        ))
      }}
    >
      Open dialog
    </button>
  )
}

describe("DialogProvider owner handling", () => {
  test("renders dialog content with the caller owner so nested app contexts remain available", () => {
    const root = document.createElement("div")
    document.body.append(root)

    const dispose = render(
      () => (
        <DialogProvider>
          <SessionProvider>
            <DialogLauncher />
          </SessionProvider>
        </DialogProvider>
      ),
      root,
    )

    root.querySelector("button")?.click()

    expect(document.querySelector("[data-component=dialog-overlay]")).not.toBeNull()
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("session-owned")

    dispose()
    root.remove()
  })
})
