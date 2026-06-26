/**
 * ConceptPicker — typeahead combobox for selecting a concept.
 * - Real-time substring filter on name/signal/style
 * - Pins "Recent" (last 5 from localStorage) and "Favorites" above the full list
 * - 28px thumbnail per row
 * - Autofocuses search on open; shows "No matches" when empty
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown, Clock, Star } from "lucide-react";
import { cn } from "@/lib/utils";

const RECENT_KEY = "mockups_recent_concepts";
const MAX_RECENT = 5;

export interface ConceptOption {
  id: number;
  conceptName: string;
  imageUrlA?: string | null;
  imageUrlB?: string | null;
  imageUrlC?: string | null;
  productionUrlA?: string | null;
  isFavorite?: boolean;
  signal?: string;
  style?: string;
}

interface ConceptPickerProps {
  concepts: ConceptOption[];
  value: string; // selected concept id as string
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

function getRecentIds(): number[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as number[];
  } catch {
    return [];
  }
}

function pushRecentId(id: number) {
  const existing = getRecentIds().filter((x) => x !== id);
  const updated = [id, ...existing].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
}

function ConceptRow({ concept, selected }: { concept: ConceptOption; selected: boolean }) {
  const thumb = concept.productionUrlA || concept.imageUrlA || concept.imageUrlB || concept.imageUrlC;
  return (
    <div className="flex items-center gap-2 min-w-0 w-full">
      {thumb ? (
        <img
          src={thumb}
          alt=""
          className="h-7 w-7 shrink-0 rounded object-contain bg-white border border-slate-200"
          loading="lazy"
        />
      ) : (
        <div className="h-7 w-7 shrink-0 rounded bg-slate-100 border border-slate-200" />
      )}
      <span className="truncate text-sm flex-1">{concept.conceptName}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />}
    </div>
  );
}

export function ConceptPicker({
  concepts,
  value,
  onChange,
  disabled,
  placeholder = "Select concept…",
}: ConceptPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [recentIds, setRecentIds] = useState<number[]>([]);

  // Load recent on mount
  useEffect(() => {
    setRecentIds(getRecentIds());
  }, [open]); // refresh when dropdown opens

  const selectedConcept = concepts.find((c) => String(c.id) === value);

  const handleSelect = useCallback(
    (id: string) => {
      onChange(id);
      pushRecentId(Number(id));
      setRecentIds(getRecentIds());
      setOpen(false);
      setSearch("");
    },
    [onChange]
  );

  // Filtered list (case-insensitive substring)
  const q = search.trim().toLowerCase();
  const filtered = q
    ? concepts.filter(
        (c) =>
          (c.conceptName ?? "").toLowerCase().includes(q) ||
          (c.signal ?? "").toString().toLowerCase().includes(q) ||
          (c.style ?? "").toString().toLowerCase().includes(q)
      )
    : concepts;

  // Pinned sections (only when not searching)
  const recentConcepts = !q
    ? recentIds
        .map((id) => concepts.find((c) => c.id === id))
        .filter(Boolean) as ConceptOption[]
    : [];

  const favoriteConcepts = !q
    ? concepts.filter((c) => c.isFavorite)
    : [];

  // Remaining concepts (exclude pinned from the "All" section when not searching)
  const pinnedIds = new Set([
    ...recentConcepts.map((c) => c.id),
    ...favoriteConcepts.map((c) => c.id),
  ]);
  const allConcepts = !q
    ? filtered.filter((c) => !pinnedIds.has(c.id))
    : filtered;

  const triggerLabel = selectedConcept?.conceptName ?? placeholder;
  const triggerThumb =
    selectedConcept?.productionUrlA ||
    selectedConcept?.imageUrlA ||
    selectedConcept?.imageUrlB ||
    selectedConcept?.imageUrlC;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between h-9 px-3 font-normal text-sm"
        >
          <span className="flex items-center gap-2 min-w-0 flex-1">
            {triggerThumb ? (
              <img
                src={triggerThumb}
                alt=""
                className="h-5 w-5 shrink-0 rounded object-contain bg-white border border-slate-200"
              />
            ) : null}
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[340px]"
        align="start"
        side="bottom"
        sideOffset={4}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search concepts…"
            value={search}
            onValueChange={setSearch}
            autoFocus
          />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No matches</CommandEmpty>

            {/* Recent section */}
            {recentConcepts.length > 0 && (
              <CommandGroup heading={
                <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Recent</span>
              }>
                {recentConcepts.map((c) => (
                  <CommandItem
                    key={`recent-${c.id}`}
                    value={String(c.id)}
                    onSelect={handleSelect}
                  >
                    <ConceptRow concept={c} selected={String(c.id) === value} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Favorites section */}
            {favoriteConcepts.length > 0 && (
              <>
                {recentConcepts.length > 0 && <CommandSeparator />}
                <CommandGroup heading={
                  <span className="flex items-center gap-1"><Star className="h-3 w-3" /> Favorites</span>
                }>
                  {favoriteConcepts.map((c) => (
                    <CommandItem
                      key={`fav-${c.id}`}
                      value={String(c.id)}
                      onSelect={handleSelect}
                    >
                      <ConceptRow concept={c} selected={String(c.id) === value} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {/* All / search results */}
            {allConcepts.length > 0 && (
              <>
                {(recentConcepts.length > 0 || favoriteConcepts.length > 0) && !q && (
                  <CommandSeparator />
                )}
                <CommandGroup heading={q ? `${allConcepts.length} result${allConcepts.length !== 1 ? "s" : ""}` : "All"}>
                  {allConcepts.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={String(c.id)}
                      onSelect={handleSelect}
                    >
                      <ConceptRow concept={c} selected={String(c.id) === value} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
