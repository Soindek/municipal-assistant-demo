> **English** · [Magyar](RETRIEVAL_NOTES.hu.md)

# Retrieval — notes and measurements

> This file durably records the context of the retrieval-redesign round (measurements, decision,
> status) so it doesn't only live in the conversation. The rationale for the decision: [DECISIONS.md](DECISIONS.md)
> #12 (the three-layer lesson) and #13 (the redesign).

## Current status (2026-06-15)

- **Merged:** the redesign is on **main** — PR **#17** (`feat/retrieval-redesign`,
  code commit `2fcf909`). The after-measurement is done (all 6 questions, on real data — see the
  table below), typecheck + lint green, the controls did not regress.
- **To close:** the `feat/retrieval-rerank` PR is **superseded** by this — close it without merging
  (otherwise there would be two overlapping rerank solutions).
- **Dependency:** the measurement required the njt-body data fix (DECISIONS #11), also on main.
- **Note:** I committed this notes file directly to main AFTER the redesign merge
  (a procedural slip relative to the "branch + PR" flow); the content is consistent with main.

## The chosen approach (in brief)

The rerank window comes from two sources, and an authority-aware LLM rerank filters it to top-K:
1. **general hybrid pool** (`hybridSearch`): pgvector cosine + Hungarian full-text
   (`ts_rank` length-norm), RRF + recency + **category weight**;
2. **guaranteed authoritative shortlist** (`authoritativeShortlist`, `rendeletek`/`oldalak`):
   **filtered-KNN with raised `hnsw.ef_search`** (against HNSW post-filter starvation) +
   **keyphrase→title match** (`extractKeyphrase` → document title).
3. **`rerankChunks`** decides the final order.

**Principle and constraints:**
- **Inclusion, not victory:** the shortlist guarantees that the authoritative source gets into the
  rerank window; the order is decided by the rerank (we don't force the decree to the top).
- **Title match only promotes on a REAL match** (empty keyphrase / no
  websearch hit → adds nothing).
- **Cross-encoder reranker is only a fallback** — it was not needed (the two above are enough).
- **Measurement across all 6 questions**, the 2 controls (dog-keeping, firewood) must not regress.

**Root bug uncovered along the way:** the config zod schema previously **stripped** the
`rag.authoritativeCategories` / `rag.categoryWeights` fields (they were not in the schema) → at runtime
`undefined`. This was also the cause of the "category weight has no effect" mystery. Added to the schema, they work.

## Before / after measurement (rank of the authoritative document)

The "before" is main's current (rerank-free) hybrid search; the "after" is the redesign's full
chain (pool + shortlist → merged window → rerank → top-8).

| Question | before (top-8 / top-20) | after (final top-8) | answer correct? |
|---|---|---|---|
| Mennyi a magánszemélyek kommunális adója? | — / — | **#2** | ✅ 12.000 Ft/adótárgy/év |
| Mennyi az építményadó? | — / — | **#4** | ✅ 220 Ft/m² |
| Mennyi a telekadó? | — / — | **#1** | ✅ |
| Mit kell tudni az ebtartásról? (control) | #1 / #1 | **#1** | ✅ (did not regress) |
| Hogyan kaphatok szociális tűzifát? (control) | #3 / #3 | **#1** | ✅ (improved) |
| Mennyi a nagyterem bérleti díja? (Gárdonyi page) | — / — | **#1** | ✅ |

**Summary:** in the baseline 4/6 didn't even make it into the top-20; after the redesign all 6
authoritative sources are in the **top-8 context**, with correct answers, and the controls did not
regress (in fact firewood improved #3→#1 and the large hall —→#1). The communal tax #2 / building
tax #4 are not #1 because the rerank ranks ahead of them a Hírmondó (newsletter) that states the
number directly — this is acceptable under the "inclusion, not victory" principle; the decree is
included and cited, and the answer is correct.
