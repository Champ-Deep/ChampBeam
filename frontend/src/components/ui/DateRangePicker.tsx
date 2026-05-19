import { useState } from 'react';
import { Calendar } from 'lucide-react';
import { Button } from './Button';

interface DateRangePickerProps {
  onRangeChange: (range: { days?: number; startDate?: string; endDate?: string }) => void;
  defaultDays?: number;
}

const PRESETS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
] as const;

export function DateRangePicker({ onRangeChange, defaultDays = 30 }: DateRangePickerProps) {
  const [activeDays, setActiveDays] = useState<number | null>(defaultDays);
  const [showCustom, setShowCustom] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const handlePreset = (days: number) => {
    setActiveDays(days);
    setShowCustom(false);
    onRangeChange({ days });
  };

  const handleCustomApply = () => {
    if (startDate && endDate) {
      setActiveDays(null);
      onRangeChange({ startDate, endDate });
    }
  };

  return (
    <div className="flex items-center gap-2">
      {PRESETS.map((p) => (
        <Button
          key={p.days}
          variant={activeDays === p.days && !showCustom ? 'primary' : 'outline'}
          size="sm"
          onClick={() => handlePreset(p.days)}
        >
          {p.label}
        </Button>
      ))}
      <Button
        variant={showCustom || activeDays === null ? 'primary' : 'outline'}
        size="sm"
        onClick={() => setShowCustom(!showCustom)}
      >
        <Calendar className="h-3.5 w-3.5 mr-1" />
        Custom
      </Button>
      {showCustom && (
        <div className="flex items-center gap-2 ml-1">
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          />
          <span className="text-slate-400 text-sm">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          />
          <Button size="sm" variant="primary" onClick={handleCustomApply} disabled={!startDate || !endDate}>
            Apply
          </Button>
        </div>
      )}
    </div>
  );
}
