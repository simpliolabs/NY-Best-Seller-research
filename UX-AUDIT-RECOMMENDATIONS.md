# NYT Design Bot — UX Audit & Product Architecture Recommendations

**Version:** 1.0  
**Date:** April 28, 2026  
**Auditor:** Manus AI (PRD Product Architect v1.4)  
**Scope:** Dashboard (/) and Book Detail (/book/:id) pages  
**Status:** Recommendations pending PO approval before implementation

> No prior approved UX specification or design system document exists for this product. This audit is original product architecture based on live production screenshots and repository code review.

---

## Source Map

| Source | Type | Sections Used |
|--------|------|---------------|
| Production screenshot: Dashboard (/) | Live UI | Layout, hierarchy, information density |
| Production screenshot: Book Detail (/book/150001) | Live UI | Content structure, concept cards, niche research |
| `client/src/pages/Dashboard.tsx` | Repository | Component structure, data flow |
| `client/src/pages/BookDetail.tsx` | Repository | Section ordering, concept rendering |
| `client/src/components/ConceptCard.tsx` | Repository | Card density, field count |
| `drizzle/schema.ts` | Repository | Data model, available fields |

---

## Executive Summary

The NYT Design Bot pipeline produces **high-value design intelligence** — AI-scored concepts, niche research, trend tracking, and generated images — but the current UI buries actionable output under dense, undifferentiated data. A user arriving at the Dashboard or Book Detail page faces a **cognitive overload problem**: every data point is presented at equal visual weight, there is no clear "winner" signal, no decision framework, and no guidance on what to do next. The result is a tool that *generates* excellent data but fails to *communicate* decisions.

The core product question this audit addresses: **"I see 30 concepts across 6 books — which one should I produce, and why?"** The current UI does not answer this question without the user manually reading every card, comparing scores, and scrolling to the bottom to find images.

---

## Problem 1: No Decision Hierarchy — Everything Looks Equal

**Severity:** Critical  
**Affected Pages:** Dashboard, Book Detail

The Dashboard shows "Top Design Concepts" as two equal-width cards side by side. The Book Detail page shows 5 concept cards in a grid, all with identical visual treatment. Score bars range from 226 to 255 — a narrow band that makes visual differentiation nearly impossible. There is no "#1 Winner" callout, no "Recommended" badge, and no explanation of why one concept scored higher than another.

**Recommendation:** Introduce a **Winner Spotlight** pattern. The highest-scoring concept per book should receive a visually distinct treatment — larger card, gold/accent border, "Top Pick" badge, and a one-sentence AI-generated rationale explaining why it won. Remaining concepts should be presented in a compact list or collapsed accordion, not as equal-weight cards. On the Dashboard, the single best concept across all books should be the hero element, not buried mid-page.

---

## Problem 2: AI-Generated Images Are Buried

**Severity:** Critical  
**Affected Pages:** Dashboard, Book Detail

The AI-generated design images are the **single most valuable output** of the entire pipeline — they are the visual proof-of-concept that a user can evaluate in seconds. Yet on the Book Detail page, images appear only at the very bottom of a long scroll, attached to the last concept card. On the Dashboard, they appear mid-page below the Top Picks section. A user who doesn't scroll past the niche research wall of text will never see them.

**Recommendation:** Move AI-generated images to the **top of the visual hierarchy**. On the Dashboard, the hero section should be a full-width "Latest Design" showcase with the top-scoring concept's image, headline, score, and a "View Details" CTA. On the Book Detail page, the winning concept's image should appear immediately below the book header, before any niche research or metadata.

---

## Problem 3: Niche Research Is a Wall of Text

**Severity:** High  
**Affected Pages:** Book Detail

The Niche Research section for "HOPE RISES" displays 5 categories (Inside Jokes, Slogans, Community References, Pain Points, Identity Markers) each containing 5-8 pill badges with full sentences. The result is a dense, unreadable wall where every item has equal visual weight. The most actionable sections — "Design Styles That Resonate" and "White Space Opportunities" — are collapsed by default, requiring extra clicks to reach the data that directly informs design decisions.

**Recommendation:** Restructure niche research into a **two-tier layout**. The top tier (always visible) should show "Design Styles That Resonate" and "White Space Opportunities" as the primary content, since these directly drive concept creation. The bottom tier (collapsed) should contain the supporting evidence — fan conversations, slogans, and identity markers — available for users who want to dig deeper. Each category should show a maximum of 3 items by default with a "Show more" toggle.

---

## Problem 4: Concept Cards Are Too Dense

**Severity:** High  
**Affected Pages:** Dashboard, Book Detail

Each concept card contains: name, format badge, style badge, humor framework tag, copyright badge, Etsy badge, score bar with number, headline in quotes, subtitle, color palette swatches, "Layout" section with a full paragraph of text (4-6 sentences), and font name. This is approximately 150-200 words per card. With 5 cards visible simultaneously, the user faces ~1,000 words of concept descriptions on a single screen — more than a typical email.

**Recommendation:** Adopt a **progressive disclosure** pattern for concept cards. The default (collapsed) view should show only: concept name, format, score bar, headline, and color palette (5 elements). The expanded view (on click) should reveal: humor framework, layout description, font, Etsy data, and the full AI-generated image. This reduces the initial cognitive load by approximately 70% while keeping all data accessible.

---

## Problem 5: Dashboard Redundancy — Top Picks vs. All Books

**Severity:** Medium  
**Affected Pages:** Dashboard

The Dashboard displays a "Top Picks" section (3 books) followed by an "All Books" section (6 books). Three of the six books appear in both sections with identical card designs. This redundancy wastes screen real estate and creates confusion about whether the sections contain different data.

**Recommendation:** Replace the dual-section layout with a **single ranked list**. Show all 6 books in a numbered list sorted by trend score, with the top 3 receiving a subtle visual distinction (accent border or "Top 3" badge). This eliminates redundancy and makes the ranking immediately clear. Alternatively, remove "All Books" entirely and link to a dedicated "/books" page for the full list.

---

## Problem 6: No "What To Do Next" Guidance

**Severity:** High  
**Affected Pages:** Dashboard, Book Detail

After viewing the data, there is no guidance on the user's next action. The Dashboard has a "Run Pipeline" button but no "Export Brief," "Share Concept," "Start Production," or "Compare Runs" actions. The Book Detail page has a "Back" button and heart icons but no workflow continuation. The tool generates intelligence but does not close the loop to action.

**Recommendation:** Add a **Next Steps** section to both pages. On the Dashboard, add action buttons: "Export Top Concepts as PDF," "Compare with Previous Run," and "Share Report." On the Book Detail page, add per-concept actions: "Export as Design Brief," "Save to Favorites with Notes," and "Generate More Variations." These actions transform the tool from a read-only report into a decision-making workflow.

---

## Problem 7: Dark Theme Reduces Readability of Dense Content

**Severity:** Medium  
**Affected Pages:** All

The dark theme works well for dashboards with charts and metrics, but this product is primarily a **text-heavy research tool**. Dense paragraphs of layout descriptions, niche research pills, and fan culture analysis are harder to scan on dark backgrounds. The color palette swatches (which are a key design output) lose contrast against the dark card backgrounds.

**Recommendation:** Switch to a **light/white theme** as the default. Light backgrounds improve readability for text-heavy content, make color palette swatches pop with true contrast, and align with the professional design-tool aesthetic (Figma, Notion, Linear all default to light). The user has explicitly requested this change.

---

## Implementation Priority Matrix

| # | Problem | Severity | Effort | Recommendation |
|---|---------|----------|--------|----------------|
| 7 | Dark theme | Medium | Low | **Switch to light theme — do first (user requested)** |
| 1 | No decision hierarchy | Critical | Medium | Winner spotlight pattern with "Top Pick" badge |
| 2 | Images buried | Critical | Medium | Move images to top of hierarchy on both pages |
| 4 | Card density | High | Medium | Progressive disclosure — collapsed/expanded cards |
| 3 | Niche research wall | High | Medium | Two-tier layout, actionable data first |
| 6 | No next steps | High | Low | Add action buttons and workflow CTAs |
| 5 | Dashboard redundancy | Medium | Low | Single ranked list, remove duplicate section |

---

## Recommended Implementation Order

**Phase 1 (Immediate — User Requested):** Switch to white/light theme.

**Phase 2 (Decision Hierarchy):** Add winner spotlight to Dashboard and Book Detail. Move AI images to top of visual hierarchy. Add "Top Pick" / "Runner Up" badges to concept cards.

**Phase 3 (Information Architecture):** Implement progressive disclosure on concept cards. Restructure niche research into two-tier layout. Merge Top Picks and All Books into single ranked list.

**Phase 4 (Workflow Completion):** Add export, share, and compare actions. Add "Next Steps" guidance section.

---

## Open Decisions (Requires PO Input)

| Decision | Impact | Options |
|----------|--------|---------|
| How many concepts to show expanded by default? | Card density | A: Top 1 expanded, rest collapsed. B: Top 3 expanded. |
| Should "All Books" section be removed or moved to separate page? | Dashboard length | A: Remove, keep Top Picks only. B: Move to /books route. |
| Export format preference? | Feature scope | A: PDF brief. B: PNG image pack. C: Both. |
| Should niche research be on Book Detail or its own tab? | Page length | A: Inline collapsed. B: Separate /book/:id/research route. |

---

*This document is a source-of-truth UX audit. All recommendations are based on live production screenshots and repository code review. No prior UX specification was available. Implementation should proceed only after PO approval of the priority matrix above.*
