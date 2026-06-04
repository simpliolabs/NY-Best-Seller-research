/**
 * CulturalMapEditor — Editable Deep Cultural Map for WorkspaceSettings.
 *
 * Renders all 9 culturalMap sub-fields as editable sections:
 * - catchphrases: simple string chips
 * - All others: structured rows with multiple fields per entry
 */
import { useState } from "react";
import { X, Plus, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { CulturalMap } from "@/../../server/onboardingRouter";

interface Props {
  culturalMap: CulturalMap;
  onChange: (updated: CulturalMap) => void;
}

export default function CulturalMapEditor({ culturalMap, onChange }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  // ─── Catchphrases (simple strings) ──────────────────────────────────────────
  function updateCatchphrase(index: number, value: string) {
    const arr = [...culturalMap.catchphrases];
    arr[index] = value;
    onChange({ ...culturalMap, catchphrases: arr });
  }
  function removeCatchphrase(index: number) {
    onChange({ ...culturalMap, catchphrases: culturalMap.catchphrases.filter((_, i) => i !== index) });
  }
  function addCatchphrase() {
    onChange({ ...culturalMap, catchphrases: [...culturalMap.catchphrases, ""] });
  }

  // ─── Generic structured array helpers ───────────────────────────────────────
  function updateStructuredItem<K extends keyof CulturalMap>(
    field: K,
    index: number,
    key: string,
    value: string
  ) {
    const arr = [...(culturalMap[field] as any[])];
    arr[index] = { ...arr[index], [key]: value };
    onChange({ ...culturalMap, [field]: arr });
  }

  function removeStructuredItem<K extends keyof CulturalMap>(field: K, index: number) {
    const arr = (culturalMap[field] as any[]).filter((_: any, i: number) => i !== index);
    onChange({ ...culturalMap, [field]: arr });
  }

  function addStructuredItem<K extends keyof CulturalMap>(field: K, template: Record<string, string>) {
    const arr = [...(culturalMap[field] as any[]), template];
    onChange({ ...culturalMap, [field]: arr });
  }

  // ─── Section config ─────────────────────────────────────────────────────────
  const SECTIONS: {
    key: keyof CulturalMap;
    label: string;
    hint: string;
    fields: { key: string; label: string; wide?: boolean }[];
    template: Record<string, string>;
  }[] = [
    {
      key: "animalMascots",
      label: "Mascots / Characters",
      hint: "Animals or characters that resonate with this niche community",
      fields: [
        { key: "animal", label: "Character" },
        { key: "whyItWorks", label: "Why it works", wide: true },
        { key: "visualTreatment", label: "Visual treatment", wide: true },
      ],
      template: { animal: "", whyItWorks: "", visualTreatment: "" },
    },
    {
      key: "painPoints",
      label: "Pain Points",
      hint: "Frustrations that can be turned into humor",
      fields: [
        { key: "pain", label: "Pain" },
        { key: "humorAngle", label: "Humor angle", wide: true },
      ],
      template: { pain: "", humorAngle: "" },
    },
    {
      key: "funPoints",
      label: "Fun Points",
      hint: "Joys and positive moments in the niche",
      fields: [
        { key: "joy", label: "Joy" },
        { key: "visualConcept", label: "Visual concept", wide: true },
      ],
      template: { joy: "", visualConcept: "" },
    },
    {
      key: "insideJokes",
      label: "Inside Jokes",
      hint: "Jokes only insiders understand",
      fields: [
        { key: "joke", label: "Joke" },
        { key: "context", label: "Context", wide: true },
      ],
      template: { joke: "", context: "" },
    },
    {
      key: "physicalComedy",
      label: "Physical Comedy",
      hint: "Funny physical scenarios in this niche",
      fields: [
        { key: "scenario", label: "Scenario", wide: true },
        { key: "whyFunny", label: "Why funny", wide: true },
      ],
      template: { scenario: "", whyFunny: "" },
    },
    {
      key: "rivalries",
      label: "Rivalries / Tensions",
      hint: "Playful rivalries within the community",
      fields: [
        { key: "rivalry", label: "Rivalry" },
        { key: "tension", label: "Tension" },
        { key: "humorAngle", label: "Humor angle", wide: true },
      ],
      template: { rivalry: "", tension: "", humorAngle: "" },
    },
    {
      key: "lifestyleIdentity",
      label: "Lifestyle Identity",
      hint: "Identity traits that drive purchases",
      fields: [
        { key: "trait", label: "Trait" },
        { key: "purchaseDriver", label: "Purchase driver", wide: true },
      ],
      template: { trait: "", purchaseDriver: "" },
    },
    {
      key: "transferableVisualConcepts",
      label: "Transferable Visual Concepts",
      hint: "Cross-niche patterns that can be adapted to this niche",
      fields: [
        { key: "sourceNiche", label: "Source niche" },
        { key: "sourcePattern", label: "Source pattern" },
        { key: "targetAdaptation", label: "Target adaptation", wide: true },
        { key: "whyItTransfers", label: "Why it transfers", wide: true },
      ],
      template: { sourceNiche: "", sourcePattern: "", targetAdaptation: "", whyItTransfers: "" },
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base" style={{ fontFamily: "Syne, sans-serif" }}>
          Deep Cultural Map
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Community intelligence that drives the Niche Hunter's character selection, vocabulary, and design adaptation
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Catchphrases — simple string chips */}
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Catchphrases / Slogans
            </label>
            <span className="text-[10px] text-muted-foreground">Approved niche vocabulary for design copy</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {culturalMap.catchphrases.map((item, i) => (
              <div key={i} className="flex items-center gap-1 bg-muted rounded-md px-2 py-1">
                <input
                  className="bg-transparent text-xs outline-none min-w-0 w-auto"
                  style={{ width: `${Math.max(item.length, 4)}ch` }}
                  value={item}
                  onChange={(e) => updateCatchphrase(i, e.target.value)}
                />
                <button
                  onClick={() => removeCatchphrase(i)}
                  className="text-muted-foreground hover:text-destructive ml-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              onClick={addCatchphrase}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md border border-dashed border-border"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
        </div>

        <Separator />

        {/* Structured sections */}
        {SECTIONS.map(({ key, label, hint, fields, template }) => {
          const items = culturalMap[key] as any[];
          const isCollapsed = collapsed[key] ?? false;

          return (
            <div key={key} className="space-y-2">
              <button
                onClick={() => toggle(key)}
                className="flex items-center gap-2 w-full text-left group"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground group-hover:text-foreground cursor-pointer">
                  {label}
                </label>
                <span className="text-[10px] text-muted-foreground ml-auto">{hint}</span>
                <span className="text-[10px] font-mono text-muted-foreground">{items.length}</span>
              </button>

              {!isCollapsed && (
                <div className="space-y-2 pl-5">
                  {items.map((item: any, i: number) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-start gap-2 p-2 rounded-md border border-border bg-muted/30"
                    >
                      {fields.map((f) => (
                        <div key={f.key} className={f.wide ? "flex-1 min-w-[200px]" : "w-[140px]"}>
                          <label className="text-[10px] text-muted-foreground">{f.label}</label>
                          <Input
                            className="h-7 text-xs"
                            value={item[f.key] ?? ""}
                            onChange={(e) => updateStructuredItem(key, i, f.key, e.target.value)}
                          />
                        </div>
                      ))}
                      <button
                        onClick={() => removeStructuredItem(key, i)}
                        className="text-muted-foreground hover:text-destructive mt-4 ml-auto"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => addStructuredItem(key, template)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md border border-dashed border-border"
                  >
                    <Plus className="h-3 w-3" /> Add {label.toLowerCase().replace(/\s.*/, "")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
