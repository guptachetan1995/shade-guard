#!/usr/bin/env bash
# Verification for the Shade Guard entry.
# Plan stage: structural checks on the docs that a judge's clone and the monorepo both carry.
# Once package.json lands, it also runs the entry's own tests and lint.
# Kept compatible with the bash 3.2 that ships on macOS: no mapfile, no negative
# array indices.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail() { echo "ERROR: $1" >&2; exit 1; }

# bin/publish.sh leaves SPEC.md out of the public repo, so the spec checks run only inside
# the monorepo; the published copy runs every other check.
in_monorepo=false
[ -f ../../bin/publish.sh ] && [ -f ../../bin/verify.sh ] && in_monorepo=true

echo "== entry root files =="
for f in README.md LICENSE .gitignore .env.example docs/submission.md; do
  [ -f "$f" ] || fail "$f is missing"
  echo "  ok: $f"
done

echo "== LICENSE is MIT and names the copyright holder =="
grep -q '^MIT License' LICENSE || fail "LICENSE is not the MIT licence text"
grep -q '^Copyright (c) 2026 Chetan Gupta$' LICENSE || fail "LICENSE copyright line changed"

echo "== .env stays out of the published repo =="
# publish.sh runs git add -A in a fresh copy where the monorepo's root .gitignore does not
# apply, so this entry's own .gitignore is the only thing keeping a local .env private.
grep -qx '.env' .gitignore || fail ".gitignore does not ignore .env"
if grep -nE '^YOUCAM_API_KEY=.+' .env.example; then
  fail ".env.example carries a key value; it must stay empty"
fi

echo "== published docs stand alone =="
published_docs=(README.md docs/*.md .env.example)
if grep -nwE 'SPEC(\.md)?' "${published_docs[@]}"; then
  fail "a published file mentions SPEC, which is never published"
fi
mono_path_re='(^|[^A-Za-z0-9_./-])(\.\./)*(entries/[a-z0-9-]+|bin/(publish|pages|ready|verify)\.sh|bin/video/)'
if grep -nE "$mono_path_re" "${published_docs[@]}"; then
  fail "a published file points into the private monorepo"
fi

echo "== no unresolved placeholders =="
placeholder_files=(README.md docs/*.md)
[ "$in_monorepo" = true ] && placeholder_files+=(SPEC.md)
if grep -nE 'TODO|TBD' "${placeholder_files[@]}"; then
  fail "a placeholder remains in: ${placeholder_files[*]}"
fi

echo "== the human-only gate is named, not just described =="
grep -qi 'never registered as a tool' README.md ||
  fail "README.md no longer states that the human verbs are never registered as a tool"

echo "== the README's status line matches reality =="
if [ -f package.json ]; then
  if grep -q 'Status: a plan, not yet code' README.md; then
    fail "package.json exists but README.md still says it is a plan, not yet code"
  fi
else
  grep -q 'Status: a plan, not yet code' README.md ||
    fail "no package.json yet, so README.md must say it is a plan, not yet code"
fi

echo "== the elevator pitch fits Devpost's 200 characters, and its stated length is current =="
pitch="$(awk '/^## Elevator pitch/{f=1;next} /^## /{f=0} f && /^> /{sub(/^> /,""); print; exit}' docs/submission.md)"
[ -n "$pitch" ] || fail "docs/submission.md has no quoted elevator pitch"
pitch_len="$(printf '%s' "$pitch" | LC_ALL=en_US.UTF-8 wc -m | tr -d ' ')"
[ "$pitch_len" -le 200 ] || fail "the elevator pitch is $pitch_len characters; Devpost allows 200"
grep -q "This one is $pitch_len:" docs/submission.md ||
  fail "docs/submission.md states a pitch length other than $pitch_len"
echo "  ok: $pitch_len characters"

echo "== the submission copy has no relative links (Devpost can't follow them) =="
if grep -nE '\]\((\.\.?/|[A-Za-z0-9_./-]+\.md)' docs/submission.md; then
  fail "docs/submission.md links a relative path; use an absolute URL or plain text"
fi

echo "== nothing published carries a signed URL or a storage host =="
# YouCam upload and result URLs are signed and expire; the recorder swaps them for local
# paths. Tests may use signed-looking URLs only on reserved .invalid hosts.
scan_paths=(README.md docs .env.example)
for d in fixtures src public scripts tests; do
  if [ -d "$d" ]; then scan_paths+=("$d"); fi
done
sig_re='[?&](X-Amz-Signature|X-Amz-Credential|Signature|Key-Pair-Id|Expires|token)='
store_re='https?://[A-Za-z0-9.-]*(amazonaws\.com|cloudfront\.net)'
hits="$(grep -rnIiE "$sig_re|$store_re" "${scan_paths[@]}" | grep -vE '\.invalid[/:?]' || true)"
if [ -n "$hits" ]; then
  echo "$hits" >&2
  fail "a published file carries a signed URL or a storage host"
fi
# The API server, the Camera Kit CDN and the console are the only makeupar.com hosts a
# published file may name; any other one is a result or upload host.
hosts="$(grep -rnoIiE 'https?://[A-Za-z0-9.-]*makeupar\.com' "${scan_paths[@]}" |
  grep -viE ':https?://(yce-api-01|plugins-media|yce)\.makeupar\.com$' || true)"
if [ -n "$hosts" ]; then
  echo "$hosts" >&2
  fail "a published file names a makeupar.com host other than the API server, CDN or console"
fi

if [ -d fixtures ]; then
  image_dirs="$(find fixtures -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) \
    -exec dirname {} \; | sort -u)"
  if [ -n "$image_dirs" ]; then
    echo "== every fixture image directory has a licence line in ASSETS.md =="
    [ -f ASSETS.md ] || fail "fixtures/ holds images but ASSETS.md is missing"
    while IFS= read -r dir; do
      grep -qF -- "$dir" ASSETS.md || fail "ASSETS.md has no licence line for $dir"
      echo "  ok: $dir"
    done <<<"$image_dirs"
  fi
fi

if [ "$in_monorepo" = true ]; then
  echo "== SPEC.md sections, in the order the spec fixes =="
  [ -f SPEC.md ] || fail "SPEC.md is missing"
  expected=(
    "1. Concept"
    "2. User and problem"
    "3. Why this wins"
    "4. What the agent does, what only a human does"
    "5. Tool list"
    "6. YouCam API"
    "7. Providers"
    "8. Architecture and stack pin"
    "9. Data model"
    "10. Demo script"
    "11. Build plan"
    "12. Owner steps"
    "13. Risks"
    "14. Submission checklist"
  )
  found=()
  while IFS= read -r line; do
    found+=("$line")
  done < <(grep -E '^## ' SPEC.md)

  [ "${#found[@]}" -eq "${#expected[@]}" ] ||
    fail "SPEC.md has ${#found[@]} top-level sections, expected ${#expected[@]}"

  i=0
  while [ "$i" -lt "${#expected[@]}" ]; do
    case "${found[$i]}" in
      "## ${expected[$i]}"*) echo "  ok: ${expected[$i]}" ;;
      *) fail "section $((i + 1)) is '${found[$i]}', expected to start with '## ${expected[$i]}'" ;;
    esac
    i=$((i + 1))
  done

  echo "== SPEC.md ends with the submission checklist =="
  last="${found[$((${#found[@]} - 1))]}"
  [ "$last" = "## 14. Submission checklist" ] ||
    fail "the last section of SPEC.md is '$last', not the submission checklist"

  echo "== the checklist is the rules' own words (live-checked 28 Sep 2026) =="
  items=(
    "Submission Period: Sep 29, 2026(12:00 pm Eastern Time) – Nov 2, 2026(11:45 am Eastern Time)"
    "by clicking the “Join Hackathon” button"
    "which includes 1,000 free API units for use during the Hackathon"
    "integrates at least one Perfect Corp. YouCam API and demonstrate clear consumer or retail value"
    "Provide a URL to your code repository for judging and testing."
    "Include a 1-3-minute Demo video showing the experience end-to-end"
    "must explain the YouCam API used in the submission"
    "must include footage that shows the Project functioning on the device for which it was built"
    "must not include third party trademarks, or copyrighted music or other material"
    "free of charge and without any restriction"
    "All Submission materials must be in English"
    "Once the Submission Period has ended, you may not make any changes or alterations to your Submission"
  )
  for item in "${items[@]}"; do
    grep -qF -- "$item" SPEC.md || fail "the submission checklist does not quote: $item"
    echo "  ok: $item"
  done

  echo "== every judging criterion is quoted and mapped =="
  criteria=(
    "> How thoroughly and skillfully does the project integrate at least one Perfect Corp. YouCam API from the Skin, Beauty, Fashion, Jewelry & Watch, Hair & Beard category?"
    "> Does the project deliver a complete, coherent product experience — not just a technical proof of concept?"
    "> Does the project make a credible, specific case for solving a real problem for a real audience — and does the solution actually address that problem based on what's demonstrated?"
    "> Is this a creative, non-obvious use of at least one Perfect Corp. YouCam API from the Skin, Beauty, Fashion, Jewelry & Watch, Hair & Beard category"
  )
  for c in "${criteria[@]}"; do
    grep -qF -- "$c" SPEC.md || fail "section 3 does not quote the criterion: $c"
    echo "  ok: ${c:2:60}…"
  done

  echo "== the video cap is stated where bin/ready.sh reads it =="
  grep -qE 'video.*at most 3 minutes' SPEC.md ||
    fail "SPEC.md no longer states the video runs at most 3 minutes"
fi

if [ -f package.json ]; then
  echo "== zero installs: package.json declares no dependencies and no lockfile exists =="
  # The entry runs on Node built-ins only, so nothing is ever installed (no npm ci, no
  # node_modules) and a fresh clone runs these checks as-is.
  node -e '
    const p = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
    const kinds = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    const found = kinds.filter((k) => p[k] && Object.keys(p[k]).length);
    if (found.length) { console.error("package.json declares " + found.join(", ")); process.exit(1); }
  ' || fail "package.json declares dependencies; this entry installs nothing"
  [ ! -e package-lock.json ] || fail "package-lock.json exists, but there is nothing to lock"
  [ ! -e node_modules ] || fail "node_modules exists, but this entry installs nothing"

  echo "== Running linter =="
  npm run --silent lint

  echo "== Running tests =="
  npm test --silent
fi

echo "shade-guard: all checks passed."
