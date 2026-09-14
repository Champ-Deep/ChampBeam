import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, Send, Sparkles, X } from 'lucide-react';
import { assistantApi } from '../api/assistant';
import type { AssistantConfig, AssistantMessage } from '../api/assistant';
import { apiErrorDetail } from '../api/_shared';

const THREAD_KEY = 'champbeam_assistant_thread';

/** The guided feature-helper thread, persisted locally per browser. */
function loadThread(): AssistantMessage[] {
  try {
    const raw = localStorage.getItem(THREAD_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AssistantMessage[]) : [];
  } catch {
    localStorage.removeItem(THREAD_KEY);
    return [];
  }
}

function saveThread(messages: AssistantMessage[]) {
  try {
    localStorage.setItem(THREAD_KEY, JSON.stringify(messages.slice(-40)));
  } catch {
    // private mode etc.; the chat still works for the session
  }
}

// A few fun, guided openers per Deep's brief: help people understand features
// and suggest things to try, then guide them to the exact place to use them.
const QUICK_PROMPTS: { label: string; prompt: string }[] = [
  { label: 'What can I do here?', prompt: 'What can I do on Champbeam, in a nutshell?' },
  { label: 'I need to send a proposal', prompt: 'I need to send a proposal to a client. What should I use and how?' },
  { label: 'Track who opened it', prompt: 'How do I make a link that tracks whether someone opened it?' },
  { label: 'Checklist behind a code', prompt: 'How do I publish a checklist page that needs an access code?' },
  { label: 'Pages and sets', prompt: 'What are Pages and “publish a set”? Show me with an example from my world.' },
  { label: 'UTM without tracking', prompt: 'How do I add UTM tags to links without shortening or tracking them?' },
];

/** Tiny markdown-lite renderer: bullets, bold, newlines, auto-linked URLs. */
function renderReply(text: string) {
  const paragraphs = text.split('\n\n');
  return paragraphs.map((p, i) => {
    if (p.trim() === '') return null;
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*[-•]\s/.test(l))) {
      return (
        <ul key={i} className="space-y-1 list-disc pl-4 my-1">
          {lines.map((l, j) => (
            <li key={j}>
              <InlineRich text={l.replace(/^\s*[-•]\s/, '')} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <p key={i} className="my-1">
        <InlineRich text={p} />
      </p>
    );
  });
}

function InlineRich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={i} className="font-semibold text-slate-900">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith('http')) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noreferrer"
              className="text-brand-purple underline break-all"
            >
              {part}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function AssistantLauncher({ isAuthenticated }: { isAuthenticated: boolean }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: config } = useQuery<AssistantConfig>({
    queryKey: ['assistant', 'config'],
    queryFn: () => assistantApi.config(),
    enabled: isAuthenticated,
  });

  useEffect(() => {
    if (open && messages.length === 0) setMessages(loadThread());
  }, [open, messages.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending, open]);

  if (!isAuthenticated) return null;

  const send = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || sending) return;
    const next: AssistantMessage[] = [...messages, { role: 'user', content: prompt }];
    setMessages(next);
    setInput('');
    setSending(true);
    setError(null);
    try {
      const result = await assistantApi.chat(next.map((m) => ({ role: m.role, content: m.content })));
      const withReply: AssistantMessage[] = [
        ...next,
        { role: 'assistant', content: result.reply },
      ];
      setMessages(withReply);
      saveThread(withReply);
    } catch (err: unknown) {
      setError(apiErrorDetail(err) ?? 'The assistant could not reply right now.');
      // Keep the user message so retry keeps context; drop nothing.
      setMessages(next);
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setMessages([]);
    localStorage.removeItem(THREAD_KEY);
    toast.info('Fresh start. New conversation.');
  };

  const providerLabel = config
    ? config.provider === 'openrouter'
      ? 'OpenRouter'
      : config.provider === 'vercel'
        ? 'Vercel AI Gateway'
        : 'Mock'
    : '';
  const modelShort = config?.model?.replace(':free', '') ?? '';

  return (
    <>
      {/* Launcher button, bottom right. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-brand-purple px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-brand-purple/90 transition-colors"
        aria-label={open ? 'Close assistant' : 'Open assistant'}
      >
        {open ? <X className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
        <span className="hidden sm:inline">{open ? 'Close' : 'Assistant'}</span>
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-40 w-[calc(100vw-2.5rem)] max-w-md h-[min(70vh,560px)] rounded-2xl border border-slate-200 bg-white shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 bg-gradient-to-r from-brand-purple/10 to-brand-teal/10">
            <div className="h-9 w-9 rounded-lg bg-brand-purple/15 flex items-center justify-center flex-shrink-0">
              <Bot className="h-5 w-5 text-brand-purple" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">Champ assistant</p>
              <p className="text-xs text-slate-500 truncate">
                {modelShort ? `${providerLabel} · ${modelShort}` : 'Your guided tour of Champbeam'}
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              className="text-xs text-slate-400 hover:text-slate-700 flex-shrink-0"
              title="Start a new conversation"
            >
              New chat
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 ? (
              <div className="space-y-4 pt-2">
                <div className="rounded-xl rounded-tl-sm bg-brand-purple/5 border border-brand-purple/15 p-3">
                  <p className="text-sm text-slate-700">
                    Hey! I am Champ, your guide around here. Tell me what you are trying to do, or
                    tap a suggestion. I will point you to the exact button, and suggest one next
                    thing to try.
                  </p>
                </div>
                <div className="space-y-1.5">
                  {QUICK_PROMPTS.map((q) => (
                    <button
                      key={q.prompt}
                      type="button"
                      onClick={() => void send(q.prompt)}
                      className="block w-full text-left rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:border-brand-purple hover:bg-brand-purple/5 transition-colors"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                >
                  <div
                    className={
                      m.role === 'user'
                        ? 'max-w-[85%] rounded-xl rounded-tr-sm bg-brand-purple px-3 py-2 text-sm text-white whitespace-pre-wrap'
                        : 'max-w-[85%] rounded-xl rounded-tl-sm bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-700'
                    }
                  >
                    {m.role === 'user' ? m.content : renderReply(m.content)}
                  </div>
                </div>
              ))
            )}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-slate-400 pl-1">
                <span className="inline-block h-2 w-2 rounded-full bg-brand-purple animate-pulse" />
                Champ is thinking…
              </div>
            )}
          </div>

          {/* Error banner (e.g. provider not configured) */}
          {error && (
            <div className="px-4 py-2 border-t border-amber-200 bg-amber-50">
              <p className="text-xs text-amber-800">{error}</p>
            </div>
          )}

          {/* Input */}
          <form
            className="flex items-center gap-2 border-t border-slate-100 px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask what to try next…"
              className="flex-1 min-w-0 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
              maxLength={4000}
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-purple text-white hover:bg-brand-purple/90 disabled:opacity-40 transition-colors"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}