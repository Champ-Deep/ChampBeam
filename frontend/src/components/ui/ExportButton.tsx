import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from './Button';

interface ExportButtonProps {
  onExport: () => Promise<void>;
  label?: string;
}

export function ExportButton({ onExport, label = 'Export CSV' }: ExportButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    try {
      setLoading(true);
      await onExport();
    } catch {
      // silent fail
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleExport} disabled={loading}>
      <Download className="h-3.5 w-3.5 mr-1.5" />
      {loading ? 'Exporting...' : label}
    </Button>
  );
}
