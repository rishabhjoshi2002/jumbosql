/**
 * pg_genie: load Monaco from the console's own bundle instead of a CDN, so the SQL editor also works on hosts
 * without internet access. Only the SQL editor page imports this (it is a lazily loaded route).
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export { monaco };
