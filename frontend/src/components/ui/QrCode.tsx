import { useState } from 'react';
import { clsx } from 'clsx';
import { Copy, Download, QrCode as QrCodeIcon, Check } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../api/client';
import { Button } from './Button';

// Build the public QR endpoint URL from the API base (already ends in /api/v1).
// This is consumed as an <img> src and via fetch for downloads, so it needs no
// auth header or CORS handling.
export function qrUrlFor(value: string): string {
  const base = api.defaults.baseURL || '';
  return `${base}/qr.svg?data=${encodeURIComponent(value)}`;
}

// Derive a sensible filename from a short link, e.g. the last path segment, so
// downloads land as "<short-code>.svg" rather than something opaque.
function deriveFilename(value: string, fallback = 'qr'): string {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return `${last}.svg`;
    if (url.hostname) return `${url.hostname}.svg`;
  } catch {
    // value was not a full URL; fall through to the fallback.
  }
  return `${fallback}.svg`;
}

// Fetch the SVG and trigger a browser download. Dependency-free: just fetch +
// Blob + an object URL on a temporary anchor.
async function downloadQr(value: string, filename: string): Promise<void> {
  const res = await fetch(qrUrlFor(value));
  if (!res.ok) throw new Error(`QR download failed: ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

interface QrCodeProps {
  /** The text/URL to encode (typically a short link). */
  value: string;
  /** Rendered pixel size of the square image. Defaults to 160. */
  size?: number;
  className?: string;
}

/** Renders a QR code for `value` as an <img> from the public QR endpoint. */
export function QrCode({ value, size = 160, className }: QrCodeProps) {
  return (
    <img
      src={qrUrlFor(value)}
      alt={`QR code for ${value}`}
      width={size}
      height={size}
      loading="lazy"
      className={clsx('rounded-lg border border-slate-200 bg-white p-2', className)}
      style={{ width: size, height: size }}
    />
  );
}

interface QrButtonProps {
  /** The text/URL to encode (typically a short link). */
  value: string;
  /** Optional explicit download filename. Defaults to "<short-code>.svg". */
  filename?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  /** When false, show an icon-only button (popover with actions). Default true. */
  withLabel?: boolean;
  className?: string;
}

/**
 * A compact QR action: a button that reveals a small popover with the QR image
 * plus Download and Copy link actions. Used in list rows where space is tight.
 */
export function QrButton({
  value,
  filename,
  size = 'sm',
  variant = 'ghost',
  withLabel = false,
  className,
}: QrButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleDownload = async () => {
    try {
      await downloadQr(value, filename ?? deriveFilename(value));
      toast.success('QR code downloaded');
    } catch {
      toast.error('Could not download QR code');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Link copied');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy link');
    }
  };

  return (
    <div className={clsx('relative inline-block', className)}>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => setOpen((v) => !v)}
        leftIcon={<QrCodeIcon className="h-3.5 w-3.5" />}
        title="QR code"
        aria-label="Show QR code"
        aria-expanded={open}
      >
        {withLabel ? 'QR' : null}
      </Button>
      {open && (
        <>
          {/* Click-away backdrop so the popover closes on outside click. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 z-50 mt-2 w-48 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
            <QrCode value={value} size={120} className="mx-auto" />
            <div className="mt-3 flex flex-col gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleDownload}
                leftIcon={<Download className="h-3.5 w-3.5" />}
              >
                Download
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={handleCopy}
                leftIcon={
                  copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />
                }
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface QrDownloadButtonProps {
  value: string;
  filename?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  className?: string;
  children?: React.ReactNode;
}

/**
 * A plain "Download QR" button (no popover) for the result card, where the QR
 * image is already shown inline and only the download action is needed.
 */
export function QrDownloadButton({
  value,
  filename,
  size = 'sm',
  variant = 'outline',
  className,
  children,
}: QrDownloadButtonProps) {
  const handleDownload = async () => {
    try {
      await downloadQr(value, filename ?? deriveFilename(value));
      toast.success('QR code downloaded');
    } catch {
      toast.error('Could not download QR code');
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={handleDownload}
      leftIcon={<Download className="h-3.5 w-3.5" />}
      className={className}
    >
      {children ?? 'Download QR'}
    </Button>
  );
}
