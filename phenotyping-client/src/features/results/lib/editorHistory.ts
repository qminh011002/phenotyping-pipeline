// editorHistory.ts — Command-pattern undo/redo history for the annotation editor.
// Each image gets its own history stack. Switching images resets the redo buffer.

import type { BBox } from "@/types/api";

// ── Operation types ─────────────────────────────────────────────────────────

export type OpType = "add" | "remove" | "move" | "resize";

export interface EditorOp {
  type: OpType;
  /** Index of the affected box */
  index: number;
  /** State before the operation */
  before: BBox[];
  /** State after the operation */
  after: BBox[];
}

// ── History state ───────────────────────────────────────────────────────────

export interface EditorHistoryState {
  past: BBox[][];   // older states
  present: BBox[];  // current state
  future: BBox[][]; // states undone (redo buffer)
}

const MAX_HISTORY = 20;

// ── Reducer ─────────────────────────────────────────────────────────────────

export type EditorHistoryAction =
  | { type: "apply"; boxes: BBox[] }         // new edit applied → push to past
  | { type: "undo" }                         // Ctrl/Cmd+Z
  | { type: "redo" }                         // Ctrl/Cmd+Shift+Z
  | { type: "reset"; boxes: BBox[] };         // reset to model (clear history)

export function editorHistoryReducer(
  state: EditorHistoryState,
  action: EditorHistoryAction,
): EditorHistoryState {
  switch (action.type) {
    case "apply": {
      // Push current present onto past (cap at MAX_HISTORY entries)
      const past = [...state.past, [...state.present]].slice(-MAX_HISTORY);
      return { past, present: action.boxes, future: [] };
    }

    case "undo": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      const newPast = state.past.slice(0, -1);
      return {
        past: newPast,
        present: previous,
        future: [state.present, ...state.future],
      };
    }

    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      const newFuture = state.future.slice(1);
      return {
        past: [...state.past, state.present],
        present: next,
        future: newFuture,
      };
    }

    case "reset": {
      // Wipe all history — from now on this is the baseline
      return { past: [], present: action.boxes, future: [] };
    }

    default:
      return state;
  }
}

/** Build the initial history state from a list of boxes. */
export function initHistory(boxes: BBox[]): EditorHistoryState {
  return { past: [], present: boxes, future: [] };
}

/** Whether undo is available. */
export function canUndo(state: EditorHistoryState): boolean {
  return state.past.length > 0;
}

/** Whether redo is available. */
export function canRedo(state: EditorHistoryState): boolean {
  return state.future.length > 0;
}
