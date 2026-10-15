# v25: generic local skill and resource routing

The local index runs independently of the model judge and the retained v24 writing
fallback. There is no new task/format-to-skill or output-to-reference path table.

## Discovery and ranking

Each user-message routing step indexes every model-invocable skill in the scoped
DSH snapshot, including already loaded skills. The snapshot's `path` and directory
`resourceBase` are authoritative, including bundled office providers. Legacy entries
without paths use user skill roots. An inaccessible explicit path never falls back
to a same-named global skill. No network discovery or dependency installation occurs.

Fields: name/directory, catalog description and whenToUse, metadata, full SKILL.md
(including trigger sections), and every regular file recursively under references,
scripts and assets. Child filenames and Markdown headings form resource labels;
text contents also contribute. Enumeration and ties use codepoint lexical order.
Symlink children are not followed. Binary files and files larger than 1 MiB retain
their filename but are not decoded/indexed as text. Files are refreshed each turn.

Normalization uses NFKC and lowercase. English word tokens and Chinese character
bigrams are deduplicated; general function words are removed (Intl segmentation
before Chinese stopword removal). Overlap is matched query tokens / query tokens.
No task names or output format aliases are encoded in the tokenizer.

Resource score = max(filename/title overlap, 0.7 * content overlap).
Skill score = max(name overlap, 0.85 * catalog/heading overlap,
0.65 * SKILL.md overlap, 0.9 * best resource score).
Scores are retrieval scores, not calibrated probabilities. Top N above minScore
are injected even if the judge returns none or times out, or repeated recommendations
would otherwise be suppressed. Existing model/writing candidates remain additive
so their R8 obligations are preserved.

The injection enumerates all discovered child paths. A reference above
resourceMinScore is marked READ FIRST with score, matched tokens and the evidence
field (filename/title or content). Other resources remain listed as available.
Every reference of a relevant skill can also become required when an output matches
its contents; loading the skill alone is not complete-read evidence.

## Output association and enforcement

The session stores the current routing result separately from R8 picks. Clearing or
waiving R8 does not clear references. New user tasks replace the routing map; generic
task turns reset read evidence even when the relevant skill is already loaded.
Session cleanup and bounded LRU storage include the new route state.

For each direct write/create_file/edit target, R7-recognizable shell write target,
or exact registered action output, R4 examines references belonging to relevant
skills (including model-only candidates). A reference matches when its contents
contain the target's extension token, or its label/content overlaps the target
basename plus proposed Markdown headings above artifactMinScore. Thus `## Methods`
can associate with `METHODS.md` and `figure legend` with `figure_legend.md`, regardless
of the skill/reference name. The reference's own `.md` suffix is not an output type.
Both routed content and current contents are considered, preventing a subsequent edit
from removing an already applicable prerequisite.

Matching requirements accumulate with global requireReads and existing specs[].requireReads.
R4 uses the existing absolute-path#sha256 evidence from accepted, successful reads
without offset/limit. Partial, failed or downstream-blocked reads do not unlock.
Any content edit invalidates the evidence. Read errors fail open per resource;
other R1–R9 checks continue. R1–R9 order and policy rules remain intact.

## Policy parameters (schema version remains 1)

```json
{
  "artifact": {
    "resourceRouting": {
      "enabled": true,
      "minScore": 0.28,
      "resourceMinScore": 0.22,
      "artifactMinScore": 0.45,
      "topN": 3
    }
  }
}
```

Omission uses these defaults (topN defaults to the router topK). No artifact section
retains the previous opt-in gate behavior. Explicit enabled=false disables this new
path. Existing specs[].requireReads are compatibility fallbacks; no entries were added.

## Validation and scope

Offline tests cover Chinese/bilingual figure legend requests, office DOCX/XLSX,
recursive references/scripts/assets, deterministic ordering and thresholds, and an
arbitrarily named skill with Methods content. Event-chain tests exercise model none,
R8 waiver, successful/partial/failed/blocked reads, file changes, already-loaded skills,
new turns and task replacement. All three write aliases, direct shell writes and
registered action outputs use the same reference enforcement.

A read-only local smoke index found 80 skill files and 172 child resources. Real
office-docx and office-xlsx rank first for their respective requests; real
figure-legend-gen and figure-legend-writer expose academic_style_guide.md and
legend_templates.md. Installed bundled office skills have no child resources, so
none are fabricated. Fixture office skills with references verify resource gating.

Lexical matching requires shared vocabulary. A Chinese query cannot independently
match an English-only skill without shared tokens or locally supplied multilingual
trigger text. The existing model judge remains available; its selected skills now
receive the same content-derived reference gate. This mechanism adds no translation
table. Script-internal outputs remain outside the host's visible write targets, as
with the existing R7 boundary. Fail-open remains intentional for unavailable inputs.

After updating, run refresh.ps1 and restart DSH to load VERSION=25.
