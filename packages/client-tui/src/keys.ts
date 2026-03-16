/**
 * TUI Keyboard Shortcuts Reference
 *
 * === Global (app.tsx) ===
 * Ctrl+C        — exit
 * Ctrl+G        — open external editor
 * Ctrl+L        — clear screen + new session
 * Escape        — close autocomplete / abort streaming / exit
 * Up/Down       — autocomplete navigation (when completions visible)
 * Tab           — accept autocomplete completion
 *
 * === Text Area (text-area.tsx) ===
 * Any char      — insert text
 * Enter         — submit
 * Shift+Enter   — newline
 * Backspace     — delete char before cursor
 * Ctrl+A        — move to line start
 * Ctrl+E        — move to line end
 * Ctrl+K        — delete to end of line
 * Ctrl+U        — delete to start of line
 * Ctrl+W        — delete word before cursor
 * Left/Right    — move cursor
 * Up/Down       — move cursor between lines (overflow fires callbacks)
 *
 * === Pickers (shared) ===
 * Escape        — cancel / go back
 * Up/Down       — navigate list
 * Enter         — select item
 *
 * === Picker-specific ===
 * KeyPicker:       Ctrl+R / Delete — revoke key
 * WorkspacePicker: Ctrl+N — new workspace, Ctrl+R — rename workspace
 * ProviderPicker:  Delete — remove provider key; typing filters list
 * ModelPicker:     typing filters providers and models
 * SessionPicker:   typing filters list
 *
 * === Tool Approval (tool-approval-prompt.tsx) ===
 * Y             — approve
 * A             — always approve
 * N             — deny (enters feedback mode)
 * Enter         — submit feedback (in feedback mode)
 */

import type { Key } from "ink";

/**
 * Returns true if the input represents a regular text character
 * (not a control key, meta combo, tab, return, escape, backspace, delete, or arrow).
 */
export function isTextInput(input: string, key: Key): boolean {
  return (
    input.length > 0 &&
    !key.ctrl &&
    !key.meta &&
    !key.tab &&
    !key.return &&
    !key.escape &&
    !key.backspace &&
    !key.delete &&
    !key.upArrow &&
    !key.downArrow &&
    !key.leftArrow &&
    !key.rightArrow
  );
}
