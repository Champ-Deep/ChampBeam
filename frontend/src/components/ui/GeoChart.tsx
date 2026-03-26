import { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Globe } from 'lucide-react';
import type { GeoBreakdownItem } from '../../api/utm';

interface GeoChartProps {
  data: GeoBreakdownItem[];
  onLevelChange?: (level: 'country' | 'region' | 'city') => void;
  level?: 'country' | 'region' | 'city';
  height?: number;
}

const TOOLTIP_STYLE = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
};

const LEVELS = ['country', 'region', 'city'] as const;

export function GeoChart({ data, onLevelChange, level = 'country', height = 320 }: GeoChartProps) {
  const [activeLevel, setActiveLevel] = useState<'country' | 'region' | 'city'>(level);

  const handleLevelChange = (newLevel: 'country' | 'region' | 'city') => {
    setActiveLevel(newLevel);
    onLevelChange?.(newLevel);
  };

  const chartData = data.slice(0, 12).map((item) => {
    let label = item.country || 'Unknown';
    if (activeLevel === 'region') {
      label = item.region ? `${item.region}, ${item.country_code || ''}` : item.country || 'Unknown';
    } else if (activeLevel === 'city') {
      label = item.city ? `${item.city}, ${item.region || item.country_code || ''}` : item.country || 'Unknown';
    }
    return {
      name: label.length > 25 ? label.slice(0, 25) + '...' : label,
      fullName: label,
      clicks: item.clicks,
    };
  });

  return (
    <div>
      {/* Level Tabs */}
      <div className="flex gap-1 mb-4">
        {LEVELS.map((l) => (
          <button
            key={l}
            onClick={() => handleLevelChange(l)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors capitalize ${
              activeLevel === l
                ? 'bg-brand-purple text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div style={{ height }}>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
              <XAxis type="number" stroke="#9ca3af" tick={{ fontSize: 12 }} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="name"
                stroke="#9ca3af"
                width={140}
                tick={{ fontSize: 12, fontWeight: 500 }}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value: number) => [value.toLocaleString(), 'Clicks']}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName || ''}
                cursor={{ fill: 'rgba(59, 130, 246, 0.06)' }}
              />
              <Bar
                dataKey="clicks"
                fill="#3b82f6"
                radius={[0, 6, 6, 0]}
                name="Clicks"
                barSize={24}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400">
            <div className="text-center">
              <Globe className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p>No geo data available</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
