/**
 * The composer's contenteditable host: binds one shell-owned Lexical editor
 * to a resident div. Session-maybe by design — a null editor renders the
 * same DOM inert (the no-session Workspace-trigger state), so switching
 * between the two never swaps the element tree. Editability has ONE writer:
 * this component reflects the `editable` prop onto the editor; nothing else
 * calls setEditable.
 */
import { useLayoutEffect, useRef } from 'react'
import type { HTMLAttributes, ReactNode, RefObject } from 'react'
import type { LexicalEditor } from 'lexical'

/** Host props: the editor binding plus the div passthroughs the bar owns. */
export interface ComposerContentEditableProps extends HTMLAttributes<HTMLDivElement> {
  /** The shell-owned editor; null renders the same div unbound and inert. */
  readonly editor: LexicalEditor | null
  /** Element owned by this composer occurrence. */
  readonly editorRef?: RefObject<HTMLDivElement>
  /** Update the Session shell when this element claims or releases the editor. */
  readonly onEditorBinding?: (bound: boolean) => void
  /** Whether the user may edit (readOnly/disabled states fold in here). */
  readonly editable: boolean
}

/**
 * Render the composer's editable surface.
 * @param props - editor binding, editability, and div passthroughs.
 * @returns the resident contenteditable div.
 */
export function ComposerContentEditable({
  editor, editorRef: suppliedRef, onEditorBinding, editable, ...rest
}: ComposerContentEditableProps): ReactNode {
  const localRef = useRef<HTMLDivElement>(null)
  const editorRef = suppliedRef ?? localRef
  useLayoutEffect(() => {
    const el = editorRef.current
    if (editor === null || el === null) return
    if (editor.getRootElement() === null) {
      onEditorBinding?.(true)
      editor.setRootElement(el)
    }
    return () => {
      if (editor.getRootElement() !== el) return
      onEditorBinding?.(false)
      editor.setRootElement(null)
    }
  }, [editor, editorRef, onEditorBinding])
  useLayoutEffect(() => {
    if (editor !== null && editor.getRootElement() === editorRef.current) editor.setEditable(editable)
  }, [editor, editorRef, editable])
  return (
    <div
      ref={editorRef}
      // Lexical's setRootElement never touches contenteditable; the binding
      // renders it, and setEditable above keeps the editor's own gate in step.
      contentEditable={editor !== null && editable}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-composer-input
      {...rest}
      onFocus={(event) => {
        // Multiple views can share this editor; the focused view takes its single root.
        if (editor !== null && editor.getRootElement() !== event.currentTarget) {
          onEditorBinding?.(true)
          editor.setRootElement(event.currentTarget)
          editor.setEditable(editable)
        }
        rest.onFocus?.(event)
      }}
    />
  )
}
