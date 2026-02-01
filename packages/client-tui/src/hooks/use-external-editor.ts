import { useCallback, useRef, useState } from "react";
import { spawn } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface UseExternalEditorOptions {
  onContent: (content: string) => void;
  onError: (message: string) => void;
}

export interface UseExternalEditorReturn {
  openEditor: (initialContent?: string) => void;
  isEditing: boolean;
}

function getEditorCommand(): string | null {
  return process.env["VISUAL"] || process.env["EDITOR"] || null;
}

export function useExternalEditor({ onContent, onError }: UseExternalEditorOptions): UseExternalEditorReturn {
  const [isEditing, setIsEditing] = useState(false);
  const isEditingRef = useRef(false);
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const openEditor = useCallback((initialContent: string = "") => {
    const editor = getEditorCommand();
    if (!editor) {
      onErrorRef.current("No editor found. Set $VISUAL or $EDITOR environment variable.");
      return;
    }

    if (isEditingRef.current) return;
    isEditingRef.current = true;
    setIsEditing(true);

    // Create temp file
    let tmpDir: string;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "molf-editor-"));
    } catch {
      onErrorRef.current("Failed to create temporary directory.");
      isEditingRef.current = false;
      setIsEditing(false);
      return;
    }

    const tmpFile = join(tmpDir, "message.md");

    try {
      writeFileSync(tmpFile, initialContent, "utf-8");
    } catch {
      onErrorRef.current("Failed to write temporary file.");
      isEditingRef.current = false;
      setIsEditing(false);
      return;
    }

    // Parse editor command (may include args, e.g. "code --wait")
    const parts = editor.split(/\s+/);
    const cmd = parts[0];
    const args = [...parts.slice(1), tmpFile];

    const child = spawn(cmd, args, {
      stdio: "inherit",
    });

    child.on("error", (err) => {
      onErrorRef.current(`Failed to launch editor: ${err.message}`);
      isEditingRef.current = false;
      setIsEditing(false);
      cleanup(tmpFile, tmpDir);
    });

    child.on("close", (code) => {
      isEditingRef.current = false;
      setIsEditing(false);

      if (code !== 0) {
        onErrorRef.current(`Editor exited with code ${code}.`);
        cleanup(tmpFile, tmpDir);
        return;
      }

      try {
        const content = readFileSync(tmpFile, "utf-8").trimEnd();
        if (content.length > 0) {
          onContentRef.current(content);
        }
      } catch {
        onErrorRef.current("Failed to read editor content.");
      }

      cleanup(tmpFile, tmpDir);
    });
  }, []);

  return {
    openEditor,
    isEditing,
  };
}

function cleanup(file: string, dir: string) {
  try { unlinkSync(file); } catch {}
  try {
    // rmdir only works on empty directories
    const { rmdirSync } = require("fs");
    rmdirSync(dir);
  } catch {}
}
