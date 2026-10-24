import { useId, useRef, useState, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { FileDropzone } from './ui/file-upload';
import AIPrompt from './kokonutui/ai-prompt';
import SmoothTab from './kokonutui/smooth-tab';
import { UPLOAD_ACCEPT } from '../config/uploadLimits';
import './composer.css';

export function ComposerInput({ text, onText, onFiles, received, busy }: {
  text: string; onText: (value: string) => void; onFiles: (files: FileList | File[]) => void;
  received: ReactNode; busy: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [dragging, setDragging] = useState(false);
  return <MotionConfig reducedMotion="user">
    <div className="cb-composer-input" data-dragging={dragging} tabIndex={0} aria-label="Drop or paste content"
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}>
      <FileDropzone id={id} accept={UPLOAD_ACCEPT} fileInputRef={input} handleBoxClick={() => undefined}
        handleDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
        handleDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) onFiles(event.dataTransfer.files); }}
        handleFileSelect={(files) => { if (files && !busy) onFiles(files); }}
        content={<>
          {dragging && <p role="status">Release to add</p>}
          {received || <AIPrompt value={text} onChange={onText} noModelControls commands={[]} headerText=""
            inputLabel="Paste content or drop one file" placeholder="Paste a complete HTML document or https://…"
            onAttach={onFiles} className="cb-composer-prompt" />}
          <div className="cb-input-footer"><button type="button" onClick={() => input.current?.click()}>Choose a file</button><span>Or paste with Cmd/Ctrl V</span></div>
        </>} />
    </div>
  </MotionConfig>;
}

export function IntentControl({ value, onChange, canHost }: {
  value: 'download' | 'host'; onChange: (intent: 'download' | 'host') => void; canHost: boolean;
}) {
  const items = [{ id: 'download', title: 'Send as file', content: <p>They download the original. Saved in Files.</p> }];
  if (canHost) items.push({ id: 'host', title: 'Host for viewing', content: <p>They view it in the browser. Saved in Pages.</p> });
  return <MotionConfig reducedMotion="user"><div className="cb-intent-control">
    <p>When the recipient opens it</p>
    <SmoothTab items={items} value={value} onChange={(next) => { if (next === 'host' || next === 'download') onChange(next); }}
      label="Recipient experience" activeColor="bg-[var(--cb-ink)]" activeTextColor="text-white" />
    {!canHost && <p className="cb-help">This file type can be downloaded, but cannot be hosted for viewing.</p>}
  </div></MotionConfig>;
}
