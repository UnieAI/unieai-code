import * as vscode from "vscode"

const TERMINAL_NAME = "unieai"

export function activate(context: vscode.ExtensionContext) {
  const openNewTerminalDisposable = vscode.commands.registerCommand("unieai-code.openNewTerminal", async () => {
    openTerminal()
  })

  const openTerminalDisposable = vscode.commands.registerCommand("unieai-code.openTerminal", async () => {
    // A UnieAI Code terminal already exists => focus it
    const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (existingTerminal) {
      existingTerminal.show()
      return
    }

    openTerminal()
  })

  const addFilepathDisposable = vscode.commands.registerCommand("unieai-code.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    const terminal =
      vscode.window.activeTerminal?.name === TERMINAL_NAME
        ? vscode.window.activeTerminal
        : vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (!terminal) {
      return
    }

    // The TUI composer supports @file mentions; type the reference into the
    // composer without submitting it.
    terminal.sendText(fileRef, false)
    terminal.show()
  })

  context.subscriptions.push(openTerminalDisposable, openNewTerminalDisposable, addFilepathDisposable)

  function openTerminal() {
    const executable = vscode.workspace.getConfiguration("unieai-code").get<string>("executablePath") || "unieai"
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        UNIEAI_CALLER: "vscode",
      },
    })

    terminal.show()
    terminal.sendText(executable)

    // If a file is open, pre-type its @mention into the composer once the TUI
    // has had a moment to start. Best-effort: typed input, never submitted.
    const fileRef = getActiveFile()
    if (fileRef) {
      setTimeout(() => {
        if (vscode.window.terminals.includes(terminal)) {
          terminal.sendText(`In ${fileRef} `, false)
          terminal.show()
        }
      }, 1500)
    }
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) {
      return
    }

    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) {
      return
    }

    // Get the relative path from workspace root
    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`
      }
    }

    return filepathWithAt
  }
}

// This method is called when your extension is deactivated
export function deactivate() {}
