# Vision benchmark assets

Each task directory holds the fixed image set, the fixed prompt, and — for the gate tasks —
the deterministic expected answers.

**The image sets are not in this repository yet.** They are being assembled from
project-owned and CC0 sources, and every asset must land with its licence, source URL and
SHA-256 recorded in the profile's `assets` array before `vision-*` profiles can freeze.

Rules for an asset:

- Project-owned or CC0/CC-BY. No scraped material, no dataset with a research-only clause.
- 1080p on the long edge, losslessly encoded, EXIF stripped.
- For `ocr`, `chart` and `document`: an entry in `expected.json` mapping the filename to a
  substring that a correct answer must contain. Grading is deterministic substring matching
  on normalised text — never an LLM judge, because a grader that varies per run would make
  the gate itself a source of variance.
- `description` and `reasoning` carry no expected answers. They are measured for speed and
  recorded, but never scored, until a stable evaluator exists.

With no images present the runner marks the vision workloads `skipped` and the result is
published unranked, rather than silently measuring nothing.
