import { useState, useCallback, useRef } from 'react';
import { Upload, FileSpreadsheet, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { clsx } from 'clsx';
import { Button } from './Button';

interface FileUploadZoneProps {
  onFileSelected: (file: File) => void;
  isUploading: boolean;
  /**
   * Accept attribute for the underlying input (e.g. ".csv", ".pdf,.mp4", "*").
   * Defaults to ".csv" to preserve the original CSV-only behavior.
   */
  accept?: string;
  /** Short label under the icon. Defaults to "Drag and drop your CSV file here". */
  label?: string;
  /** Hint shown at the bottom. Defaults to "Accepted: .csv, Required column: url". */
  hint?: string;
  /** Loading caption. Defaults to "Processing CSV...". */
  uploadingLabel?: string;
}

export function FileUploadZone({
  onFileSelected,
  isUploading,
  accept = '.csv',
  label,
  hint,
  uploadingLabel,
}: FileUploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const acceptCsvOnly = accept === '.csv';

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const files = e.dataTransfer.files;
      const file = files[0];
      if (file) {
        if (!acceptCsvOnly) {
          onFileSelected(file);
          return;
        }
        if (file.type === 'text/csv' || file.name.endsWith('.csv')) {
          onFileSelected(file);
        } else {
          toast.error('Please upload a CSV file');
        }
      }
    },
    [onFileSelected, acceptCsvOnly]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        onFileSelected(file);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [onFileSelected]
  );

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={clsx(
        'relative border-2 border-dashed rounded-xl p-10 text-center transition-all duration-200 cursor-pointer',
        isDragOver
          ? 'border-brand-purple/70 bg-brand-purple/5 scale-[1.01]'
          : 'border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-white'
      )}
      onClick={() => fileInputRef.current?.click()}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        onChange={handleFileInput}
        className="hidden"
      />

      {isUploading ? (
        <div className="flex flex-col items-center">
          <Loader2 className="h-10 w-10 text-brand-purple animate-spin mb-3" />
          <p className="text-sm font-medium text-slate-700">
            {uploadingLabel ?? 'Processing CSV...'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <div className="h-14 w-14 rounded-full bg-brand-purple/10 flex items-center justify-center mb-4">
            <Upload className="h-6 w-6 text-brand-purple" />
          </div>
          <p className="text-sm font-medium text-slate-700 mb-1">
            {isDragOver
              ? 'Drop your file here'
              : (label ?? 'Drag and drop your CSV file here')}
          </p>
          <p className="text-xs text-slate-500 mb-4">or click to browse</p>
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            <FileSpreadsheet className="h-4 w-4 mr-1.5" />
            Browse Files
          </Button>
          <p className="text-xs text-slate-400 mt-4">
            {hint ?? 'Accepted: .csv, Required column: url'}
          </p>
        </div>
      )}
    </div>
  );
}
