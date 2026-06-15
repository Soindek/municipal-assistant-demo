> [English](RETRIEVAL_NOTES.md) · **Magyar**

# Retrieval — jegyzetek és mérések

> Ez a fájl a retrieval-redesign kör kontextusát rögzíti tartósan (mérések, döntés,
> állapot), hogy ne csak a beszélgetésben éljen. A döntés indoklása: [DECISIONS.md](DECISIONS.md)
> #12 (a háromrétegű tanulság) és #13 (a redesign).

## Aktuális állapot (2026-06-15)

- **Mergelve:** a redesign a **main-en** van — PR **#17** (`feat/retrieval-redesign`,
  kód-commit `2fcf909`). Az after-mérés megtörtént (mind a 6 kérdés, valódi adaton — lásd a
  táblát lent), typecheck + lint zöld, a kontrollok nem romlottak.
- **Lezárandó:** a `feat/retrieval-rerank` PR-t ez **kiváltja** — zárd le mergelés nélkül
  (különben két átfedő rerank-megoldás lenne).
- **Függőség:** a méréshez kellett az njt-törzs adat-fix (DECISIONS #11), szintén main-en.
- **Megjegyzés:** ezt a notes-fájlt a redesign merge UTÁN, közvetlenül a main-re commitoltam
  (eljárási csúszás a „branch + PR" folyamathoz képest); a tartalom a mainnel konzisztens.

## A választott megközelítés (röviden)

A rerank-ablak két forrásból áll, és egy tekintély-tudatos LLM-rerank szűri top-K-ra:
1. **általános hibrid pool** (`hybridSearch`): pgvector koszinusz + magyar full-text
   (`ts_rank` hossz-norm), RRF + frissesség- + **kategória-súly**;
2. **garantált hiteles-shortlist** (`authoritativeShortlist`, `rendeletek`/`oldalak`):
   **filtered-KNN emelt `hnsw.ef_search`-csel** (a HNSW post-filter éhezés ellen) +
   **kulcskifejezés→cím-egyezés** (`extractKeyphrase` → dokumentum-cím).
3. **`rerankChunks`** dönti a végső sorrendet.

**Elv és kikötések:**
- **Behozatal, nem győzelem:** a shortlist garantálja, hogy a hiteles forrás bekerül a
  rerank-ablakba; a sorrendet a rerank dönti (nem nyomjuk fel erőből a rendeletet).
- **Cím-egyezés csak VALÓDI illeszkedésnél** emel be (üres kulcskifejezés / nincs
  websearch-találat → nem ad hozzá semmit).
- **Cross-encoder reranker csak tartalék** — nem volt rá szükség (a fenti kettő elég).
- **Mérés mind a 6 kérdésen**, a 2 kontroll (ebtartás, tűzifa) nem romolhat.

**Mellékesen feltárt gyökérbug:** a config zod-séma korábban **lestrippelte** a
`rag.authoritativeCategories` / `rag.categoryWeights` mezőket (nem voltak a sémában) → runtime-ban
`undefined`. Ez a „kategória-súly nem hat" rejtély oka is volt. A sémába felvéve működnek.

## Before / after mérés (a hiteles dokumentum rangja)

A „before" a main jelenlegi (rerank nélküli) hibrid keresése; az „after" a redesign teljes
lánca (pool + shortlist → egyesített ablak → rerank → top-8).

| Kérdés | before (top-8 / top-20) | after (final top-8) | válasz helyes? |
|---|---|---|---|
| Mennyi a magánszemélyek kommunális adója? | — / — | **#2** | ✅ 12.000 Ft/adótárgy/év |
| Mennyi az építményadó? | — / — | **#4** | ✅ 220 Ft/m² |
| Mennyi a telekadó? | — / — | **#1** | ✅ |
| Mit kell tudni az ebtartásról? (kontroll) | #1 / #1 | **#1** | ✅ (nem romlott) |
| Hogyan kaphatok szociális tűzifát? (kontroll) | #3 / #3 | **#1** | ✅ (javult) |
| Mennyi a nagyterem bérleti díja? (Gárdonyi oldal) | — / — | **#1** | ✅ |

**Összegzés:** baseline-ben 4/6 a top-20-ba sem került be; a redesign után mind a 6 hiteles
forrás a **top-8 kontextusban** van, helyes válaszokkal, a kontrollok nem romlottak (sőt a
tűzifa #3→#1 és a nagyterem —→#1 javult). A kommunális #2 / építmény #4 azért nem #1, mert a
rerank egy a számot közvetlenül kimondó Hírmondót rangsorol elé — ez a „behozatal, nem
győzelem" elv szerint elfogadott; a rendelet bekerül és idéződik, a válasz helyes.
