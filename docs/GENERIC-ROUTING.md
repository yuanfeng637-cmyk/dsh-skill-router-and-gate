# v26: fielded IDF routing and executable reading prerequisites

This index is offline and deterministic. It has no task-to-skill, format-to-skill,
or artifact-to-reference destination table. The host snapshot remains authoritative
for candidate eligibility. Existing model/writing routing and R1–R9 stay in place.

## Discovery and language normalization

Both catalog modes read SKILL.md. Catalog description/whenToUse take precedence;
missing fields are recovered from YAML frontmatter (plain, quoted, folded, literal
text only; no YAML execution). Explicit paths/resourceBase are authoritative and
never fall back to a same-named global skill. Name-only entries use user skill
roots and installed DSH provider assets. Provider roots are discovered from the
local pnpm dsh-skill provider packages, without adding any names to the snapshot.
Caller-supplied roots replace this discovery, allowing isolated fixture tests.

Resources under references/scripts/assets remain recursive, deterministic,
refreshed each turn and limited to regular files. No symlink child traversal,
network access, dependency installation or changes to installed skill materials.

NFKC and lowercase precede tokenization. English plurals lose a final s (length >4,
excluding ss); Chinese uses Intl word segmentation and within-word bigrams, never
bigrams fabricated by joining unrelated words after stopword removal. Function
words are removed. A small explicit bilingual lexical vocabulary is applied
symmetrically to queries and all indexed fields. It contains word equivalences,
including legend/图注, material method/材料方法 and phylogenetic/系统发育, plus
common research, document, data and software words. Authoring verbs share an
authoring token and reading verbs share a reading token. It contains no skill
identifiers, destination paths, query predicates or preferred candidates. This
lexicon is auditable in resourceindex.js; it is not an unrestricted translator.
Previously Chinese-only requests had no lexical bridge to English-only legends.
Adding multilingual skill metadata remains preferable for vocabulary not covered.

## Exact scoring rule

Let N be the eligible skill count. df(t) counts skills containing t anywhere in
name, declaration, body or child resources, at most once per skill, irrespective
of the number of children or repeated occurrences.

```
idf(t) = ln(1 + (N + 0.5) / (df(t) + 0.5))
coverage(Q,F) = sum(idf(t) for t in Q intersect F) / sum(idf(t) for t in Q)
match(Q,F) = coverage(Q,F) / (1 + 0.12 * ln(1 + |F| / max(1,|Q|)))
```

Q and F are deduplicated token sets. Unseen query words remain in the denominator.
The length is distinct vocabulary size; copying a keyword or boilerplate does not
increase the score. Empty query or field match gives zero.

Child score is max(match(filename/headings), 0.70 * match(content)). A reference
at or above resourceMinScore=0.22 is READ FIRST. Scripts/assets stay discoverable.

The field contributions and final fusion are:

```
D = 1.00 * match(description + whenToUse)
N = 0.90 * match(skill name)
H = 0.75 * match(SKILL.md headings)
B = 0.45 * match(SKILL.md body)
R = 0.55 * max(child scores)
score = compatibility * (max(D,N,H,B,R) + 0.25*D + 0.75*N + 0.50*R + 0.15*B) / 2.275
```

The description has the largest base weight; name and resource corroboration
reinforce it. The denominator bounds this retrieval score below 1. This is not a
probability. compatibility=0.50 only when the query asks for authoring and the
skill name/declaration explicitly contains reading but no authoring; otherwise 1.
This suppresses a read-only table inspection skill for a table creation request,
without naming either skill or any format.

Admission requires score >= minScore=0.28 AND a lead over the runner-up >=
minMargin=0.02. All candidates, including those below minScore, participate in
the margin comparison. A tie or insufficient margin returns [] (no route).
The accepted winner is returned; topN=3 is an upper bound, not an obligation to
fill slots with weaker skills. rankResourceCandidates exposes the field evidence
for diagnosis. Enumeration order cannot decide an ambiguous route.

Other defaults remain enabled=true, resourceMinScore=0.22,
artifactMinScore=0.45, topN=3. Existing project policy values need no modification;
minMargin defaults to 0.02 when absent.

## Reading enforcement and side effects

Every selected skill with no selected reference gets its readable SKILL.md as
an explicit READ FIRST prerequisite. It is a real absolute file path, passed to
the existing R4 absolute-path#sha256 complete-read check. Its basis is shown as
SKILL.md fallback. Since it is the selected workflow's entry point, its fallback
requirement applies to every host-visible output during that routed turn,
including write/edit/create_file, recognized shell writes and registered outputs.
A skill load alone, a claimed path, a partial/failed/blocked read, or an old hash
does not satisfy this complete-read evidence. The fallback adds stricter reads:
an unrelated visible output in that turn may also require the entry point.

Existing selected references retain their content-derived artifact association:
output extension in the reference text, or basename/proposed headings matching
at artifactMinScore. Current and routed contents are both considered. These
requirements accumulate with global requireReads and ALL matching specs; no
policy entries were replaced. Model-only/writing-only candidates also expose
reference prerequisites, or the same SKILL.md fallback when no reference exists.
If the scoped skill has neither readable children nor readable SKILL.md, the
injection explicitly says “该技能无可前置阅读的资源”. It does not fabricate a path.
Existing unavailable-file fail-open behavior and the script-internal output
visibility boundary remain unchanged.

Loaded skills are still indexed. An opted-in artifact policy re-injects their
fresh per-turn reads; without that policy existing loaded-skill suppression is
preserved. R8 disposition is independent from R4 reading evidence. R1–R9 order
and assertions were not weakened.

## Reproducible validation and the missing candidate

The supplied original command was run before changes and reproduced all five
reported failures. Its 79 directory entries do not contain office-xlsx. Actual
bundled provider assets add office-docx/office-pptx/office-xlsx, making 82 entries,
with the same 172 child resources. The full roster achieves all five expected
routes in BOTH name-only (default provider-root discovery) and full-catalog modes.
The original 79-entry input now abstains for XLSX instead of inventing a candidate
outside the snapshot. It cannot return office-xlsx without that name being admitted
by the caller. This is a catalog-completeness limitation, not a hidden test fix.

Run the local smoke (read-only except --capture writes the test corpus):

```
D:\node\node.exe _test/local-routing-smoke.mjs
D:\node\node.exe --test --import ./_test/resolve-stub.mjs
```

routing-corpus.json stores the real 82-entry corpus's deduplicated lexical features,
resource paths relative to each skill and source SKILL.md SHA256, without source
prose or executable code. Regression tests reconstruct isolated skill files from
those features and exercise BOTH buildResourceIndex input modes with all distractors.
The original figure legend/DOCX/XLSX fixture is shared unchanged. New tests also
cover ambiguity, body boilerplate, absent candidates, no-readable-resource status,
YAML text styles and executable/hash-invalidating SKILL.md fallback enforcement.

See validation-v26-routing.txt for the exact local outputs and
validation-v26-tests.txt for the full 95-pass/0-fail/0-skip test output.
After refresh.ps1 and refresh.ps1 -Verify, restart DSH to load VERSION=26.
