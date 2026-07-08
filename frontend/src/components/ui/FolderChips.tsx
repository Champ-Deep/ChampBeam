import { clsx } from 'clsx';
import { ExternalLink, Inbox, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import type { DragEvent, ReactNode } from 'react';

export interface FolderChipItem {
  id: string;
  name: string;
  count: number;
}

interface FolderChipsProps {
  /** Sentinel id for the "All" chip (usually ''). */
  allId: string;
  allLabel?: string;
  allCount: number;
  /** Sentinel id for the "Unfiled" chip. */
  unfiledId: string;
  unfiledLabel?: string;
  unfiledCount: number;
  /** Real folders/projects. */
  folders: FolderChipItem[];
  /** Currently selected filter id. */
  activeId: string;
  /** Folder currently under the cursor during a drag (highlight), or null. */
  dragOverId: string | null;
  /** Whether a row drag is in progress (surfaces the drop hint). */
  isDragging?: boolean;
  onSelect: (id: string) => void;
  onDragOver?: (e: DragEvent, id: string) => void;
  onDragLeave?: (id: string) => void;
  onDrop?: (e: DragEvent, id: string) => void;
  onNew?: () => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onOpenDetail?: (id: string) => void;
  /** Optional inline create/edit form rendered directly under the chip row. */
  form?: ReactNode;
}

// Folder chips: the App v2 folder layout. A wrap-around pill row that filters
// the list and doubles as drag-and-drop drop targets. The active real folder
// reveals inline rename / detail / delete controls so no functionality is lost
// versus the old sidebar rail.
export function FolderChips({
  allId,
  allLabel = 'All',
  allCount,
  unfiledId,
  unfiledLabel = 'Unfiled',
  unfiledCount,
  folders,
  activeId,
  dragOverId,
  isDragging,
  onSelect,
  onDragOver,
  onDragLeave,
  onDrop,
  onNew,
  onEdit,
  onDelete,
  onOpenDetail,
  form,
}: FolderChipsProps) {
  const chipClass = (active: boolean, over: boolean) =>
    clsx(
      'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-all cursor-pointer',
      over
        ? 'text-[var(--cb-accent)]'
        : active
          ? 'text-[var(--cb-accent)]'
          : 'text-[var(--cb-text-mid)] hover:text-[var(--cb-ink)]'
    );

  const chipStyle = (active: boolean, over: boolean) =>
    over
      ? {
          border: '1px solid var(--cb-accent)',
          background: 'var(--cb-accent-soft)',
          boxShadow: '0 0 0 3px rgba(var(--cb-accent-rgb),.15)',
        }
      : active
        ? { border: '1px solid var(--cb-accent-border)', background: 'var(--cb-accent-soft)' }
        : { border: '1px solid var(--cb-border-strong)', background: '#fff' };

  const countBadge = (active: boolean, over: boolean, n: number) => (
    <span
      className="rounded-md px-1.5 py-0.5 text-[10.5px] font-bold"
      style={
        active || over
          ? { background: 'rgba(var(--cb-accent-rgb),.14)', color: 'var(--cb-accent)' }
          : { background: 'var(--cb-chip)', color: 'var(--cb-muted)' }
      }
    >
      {n}
    </span>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* All (filter only, not a drop target) */}
        <button
          type="button"
          onClick={() => onSelect(allId)}
          className={chipClass(activeId === allId, false)}
          style={chipStyle(activeId === allId, false)}
        >
          <Layers className="h-3.5 w-3.5" />
          <span>{allLabel}</span>
          {countBadge(activeId === allId, false, allCount)}
        </button>

        {/* Unfiled (filter + drop target) */}
        <button
          type="button"
          onClick={() => onSelect(unfiledId)}
          onDragOver={onDragOver ? (e) => onDragOver(e, unfiledId) : undefined}
          onDragLeave={onDragLeave ? () => onDragLeave(unfiledId) : undefined}
          onDrop={onDrop ? (e) => onDrop(e, unfiledId) : undefined}
          className={chipClass(activeId === unfiledId, dragOverId === unfiledId)}
          style={chipStyle(activeId === unfiledId, dragOverId === unfiledId)}
        >
          <Inbox className="h-3.5 w-3.5" />
          <span>{unfiledLabel}</span>
          {countBadge(activeId === unfiledId, dragOverId === unfiledId, unfiledCount)}
        </button>

        {/* Real folders */}
        {folders.map((f) => {
          const active = activeId === f.id;
          const over = dragOverId === f.id;
          return (
            <div
              key={f.id}
              onDragOver={onDragOver ? (e) => onDragOver(e, f.id) : undefined}
              onDragLeave={onDragLeave ? () => onDragLeave(f.id) : undefined}
              onDrop={onDrop ? (e) => onDrop(e, f.id) : undefined}
              className={chipClass(active, over)}
              style={{ ...chipStyle(active, over), paddingRight: active ? 6 : undefined }}
            >
              <button
                type="button"
                onClick={() => onSelect(active ? allId : f.id)}
                className="inline-flex items-center gap-2"
              >
                <span className="max-w-[160px] truncate">{f.name}</span>
                {countBadge(active, over, f.count)}
              </button>
              {active && (onOpenDetail || onEdit || onDelete) && (
                <span className="ml-0.5 flex items-center gap-0.5">
                  {onOpenDetail && (
                    <button
                      type="button"
                      onClick={() => onOpenDetail(f.id)}
                      title="Open detail"
                      className="rounded p-0.5 hover:bg-white/60"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  )}
                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(f.id)}
                      title="Rename"
                      className="rounded p-0.5 hover:bg-white/60"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => onDelete(f.id)}
                      title="Delete"
                      className="rounded p-0.5 text-[#C5363B] hover:bg-white/60"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}

        {/* New folder */}
        {onNew && (
          <button
            type="button"
            onClick={onNew}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors"
            style={{ border: '1px dashed var(--cb-border-strong)', color: 'var(--cb-text-mid)' }}
          >
            <Plus className="h-3.5 w-3.5" />
            New folder
          </button>
        )}
      </div>

      {isDragging && (
        <p className="text-xs font-medium" style={{ color: 'var(--cb-accent)' }}>
          Drop on a folder chip to file the dragged items.
        </p>
      )}

      {form}
    </div>
  );
}
