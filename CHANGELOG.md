# Changelog

## 0.20.0 Beta

- Separate local PDF text extraction, Tesseract OCR and rule-based custom fields/tags from optional AI review. AI off makes no model calls and still prepares manual reviews.
- Simplify processing to Review first or Fully automatic, with truthful per-mode controls and one tag selection method. Grey only AI-dependent suggestions when AI is off.
- Merge batch history into Processing. Expand individual imports to inspect recorded results and filing events, select past imports without polling clearing the selection, and verify current file locations before reprocessing.
- Keep document tag removals and field/tag saves in place instead of reloading the full library or PDF. Reuse existing OpenCloud tags regardless of capitalization.
- Add clearer document expansion arrows, editable filing destinations, all-format library browsing and optional PDF conversion while preserving originals.
- Preserve native resource identity, fields, tags and history when files or parent folders are renamed or moved inside the filed-document root.
- Package a store ZIP with manifest.json at its root, a coordinated companion installation kit, matching source, dependency inventory and licensed synthetic screenshots.


## 0.19.8

- Reuse existing tag spelling without case-sensitive duplicates in pickers and connected tag-rule saves. Keep existing native variants distinct.
- Add confirmed per-document tag removal with durable intents and read-only recovery; preserve fields, other documents, bytes and original filing approvals. Show expanding/collapsing chevrons on document rows.

- Replace separate AI input/output settings with one On/Off AI processing choice; OCR also uses On/Off. Give filename, folder and field controls action-specific choices.
- Group tag selection and application in one Tags section. Preserve existing values and conservatively project legacy review gates so saving cannot silently enable automatic filing.

## 0.19.7

- Show current Inbox processing by default in Activity; calculate totals from the same complete live listing as Inbox. Keep old attempts in an optional past-import history without treating them as outstanding reviews or retries.
- Keep unresolved filing/running operations visible and recheck current file identity before retrying. Preserve historical results and completed filing records.

## 0.19.6

- Follow file renames and parent-folder moves inside the configured Documents destination by OpenCloud resource identity. Keep original approvals and source paths as history, with current paths and native tags resolved separately.
- Refresh browsing and filing history on return and while visible, protecting unsaved edits. Locate moved filed documents before preview, verification and reprocessing; never adopt copies or relax content checks.

## 0.19.5

- Show live document preparation stages on Inbox document details and reviews, including queued, paused, OCR, AI and tag review states.
- Persist safe direct-preparation failures and distinguish interrupted work from active processing. Status reads preserve drafts and recheck current source identity and access.


## 0.19.4

- Allow recoverable Trash for unrelated documents during background processing; protect the active resource throughout reading, OCR and AI preparation with a per-resource lock.
- Distinguish a confirmed pre-intent refusal from an uncertain deletion. Automatically check uncertain outcomes without replaying DELETE; keep normal Trash to confirmation and completion.

## 0.19.3

- Keep verified background connections preferred over browser sessions for processing and backups, including token rotation and manual-only workflows.
- Pause queued batch work when credentials are unavailable; resume queued work after verified background reconnection. Add operation-scoped retry of held preparations without repeating completed results.
- Confirm removal of used field/tag definitions, preserve existing document data, and show unknown usage conservatively. Usage now includes saved metadata and applied tags in both configured Inbox and Documents.

## 0.19.2

- Split Fields & tags settings into accessible tabs with compact expandable entries, preserving drafts when switching tabs. Show saved field/tag usage counts from the complete current Documents library; unavailable counts remain unknown.

- Add New folder to the manual filing destination picker, preserving the filename and creating the folder only on document acceptance.
- Validate folder names and discard unfinished folder choices when cancelling or changing Spaces.

## 0.19.1

- Original formats no longer show a conversion-required attention banner. Manual filing appears below fields and tags in the usual action area; optional PDF conversion is separate.
- Name the browsing action Open location in OpenCloud and describe preview availability separately from filing.
- Group search, format and checkbox-based tag filters together; place compact layout controls beside the document list.

## 0.19.0

- Explicit, confirmed Move to OpenCloud Trash for filed documents and Inbox reviews, including a clear action beside potential-duplicate comparisons. Verify unknown outcomes without repeating deletion; retain review records and metadata.
- Manually file original formats, including CAD files, by choosing a folder, filename and tags. No PDF conversion, OCR or AI call is required. Keep the original extension and bytes, using the existing exact approval and verified cross-Space transfer.
- Remove the duplicate metadata Edit action from the single-file conversion toolbar. Rejected suggestions now finish at 5/5 with File kept in place, distinct from files actually moved to Trash.

## 0.18.0

- Browse the complete configured document destination in a flat list or folder tree, with inline previews and details that retain your place. Search names, paths, tags and saved fields; combine tag and format filters. Tag choices narrow with results, and filtered folder trees hide branches without matching files.
- Move filing history into Activity, preserving legacy links and recorded filing checks.
- Review Filing, Fields and Tags as peer sections. Show the suggested filename and folder separately, offer manual tag selection, and label the explicit filing action Accept alongside Reject.
- Retain source identity, pending-save, exact approval and recovery guards; browsing never converts or prepares files.

## 0.17.9

- Sort Activity processing records by document, status, stage or numeric attempts, including remaining history pages. Sorting survives polling and keeps selections bound to document identities.
- Add Reprocess to document reviews, PDF library details, Inbox selections and Activity rows. Explicit requests always create a fresh review using current settings, preserving earlier reviews and completed filing history.
- Locate filed originals and pin their current resource identity and ETag; unresolved filing, automatic or metadata operations block reprocessing. Reprocessing does not grant filing or tag-write approval. Activity actions open their durable preparation results.

## 0.17.8

- Count the complete focused tag-review prompt and both existing/new response schemas in cloud capacity checks before submitting document data. Oversized tag libraries remain held without clipping source pages or switching providers.

## 0.17.7

- Add optional AI tag review: choose existing tags by document meaning, or allow evidence-backed new candidates when no close existing tag fits. Matching rules remain the default.
- Snapshot the authenticated tag directory, use a focused tag-model pass, label new candidates, and retain explicit approval or saved automatic-stage authorization for creation. Directory errors and changed discovery settings hold processing.
- Show tag evidence beside the other AI claims and a dedicated tag-review progress label.

## 0.17.6

- Separate compact tag chips from primary save actions and put evidence-backed suggestions ahead of the collapsible saved-tag library.
- Ask AI review to consider supported subject, type and person tags independently without adding unsupported tags to fill a quota. Existing reviews and evidence validation remain unchanged.

## 0.17.5

- Reconnect fresh browsers and devices to the signed-in user's verified workflow Space without relying on browser-local selection or a fixed server Space ID. Recheck current access and pin the resolved Space before loading intake and documents.
- Keep the cross-device selection scoped to the authenticated server/account; ambiguous existing workflows require a verified explicit selection.

## 0.17.4

- Clarify AI guidance for the issuing organization versus recipients, applicants and employees, and document titles versus table labels and form footers. Exact evidence and manual review safeguards remain unchanged; quoted words alone do not prove their role.

## 0.17.3

- Browse every file type in the configured document destination, including manually stored images and Office files, without conversion or ingestion. Keep filing history separately searchable.
- Add a destination-folder picker and selectable/removable tag chips with existing OpenCloud and saved workflow tags. New tags remain drafts until explicit filing or metadata save.
- Preserve native files outside PDF review and offer OpenCloud viewing. Background intake remains PDF-only; conversion remains an explicit Inbox action.

## 0.17.2

- Default background App Token login to the authenticated user's OpenCloud account name, separately from the immutable account ID. Do not guess from a display name or opaque ID if the login is unavailable.
- Clear unfinished background-connection credentials when the signed-in account changes; preserve manual username edits during same-account refreshes.

## 0.17.1

- Do not mistake ordinary mixed-case words for ISO currency codes when comparing scans. Keep date, identifier and amount safeguards for recurring bills.
- Hide the previous field-validation warnings while preparing a fresh review; restore them if the request fails.

## 0.17.0

- Reuse the operating-system dependency layer across releases instead of rebuilding it for every version number, reducing upgrade storage and downloads.

- Read large scanned backgrounds behind sparse selectable text, preserving both embedded text and the original PDF. Plain short text PDFs are left alone. Retry an empty OCR result once with local contrast thresholding to recover photographed receipts on white pages.

- Show independently verified details and field-specific failure explanations when a complete AI review cannot be accepted. Invalid claims remain excluded; existing reviews and filing approvals are not rewritten.
- Recover unique case-only quotations and wrapped printed titles while preserving the exact source span. Convert line wrapping to spaces only when rendering a filename; changed letters, ambiguous quotations and control characters remain held.
- Recognize CJK heading and multi-character name aliases despite PDF layout spaces, without joining separate lines or weakening one-character-name safeguards.
- Offer AI only category/tag choices whose terms have source support, retaining every source page and the full rules in the approval snapshot.
- Verify native Ollama context rejection before allowing documents beyond a conservative byte estimate. Disable input truncation and context shifting, check returned token counts, and retain conservative handling for unsupported servers and cloud routes. Service outages remain retryable failures. Allow larger local requests a source-size-based deadline bounded between two and five minutes.
- Recognize additional complete printed dates, including abbreviated English months, year-first slash/dot dates and dates beside times. Give AI bounded source date passages and field-specific correction feedback without repairing missing OCR characters or guessing ambiguous dates.
- Flag conservative potential duplicates using matching printed identifiers, dates, amounts and text. Comparison links recheck current file access and identity. Similarity never authorizes Trash; automatic filing holds for comparison.
- Keep bulk preparation results live, open the exact newly prepared review, retain the actual failed stage and clear stale error banners while a retry is queued. A newer successful preparation supersedes an older batch error.
- Allow destination editing when source-backed names cannot form a safe filename, without silently truncating the name or filing the document.
- Prepare fresh reviews for selected manual items, pinned to the selected file identity and version. Show active preparation stages and include preparation batches in global pause, resume, cancel and safe retry controls. Originals and prior review records are kept.

## 0.16.6

- Restore top padding around the manual-review heading and preparation button.

## 0.16.5

- Place Prepare again beside the Manual review heading as a standard bordered button, with responsive spacing and an accessible processing state.

## 0.16.4

- Export wide, static label/value spreadsheet records as readable portrait pages; preserve source workbooks and verified previous PDF versions. Other spreadsheets retain fitted landscape export with wrapped labels.
- Refresh the visible PDF immediately after recreation changes its bytes.

## 0.16.0–0.16.3

- Create reviewable PDF copies of supported images, Office documents, text and XPS files using an isolated converter. Verify each PDF before archiving its original outside the Inbox.
- Add recoverable spreadsheet PDF recreation with verified version backups, source checks and read-only reconciliation of uncertain responses.

## 0.15.3

- Restore actual source characters for unique Unicode presentation matches, and restore a complete printed date only when configured calendar rules prove equivalence to the model date. Missing date components, ambiguous conventions and changed values remain held.

- Recover an out-of-range AI citation only when its unchanged quote identifies one actual PDF page; ambiguous citations and unprinted facts remain held.
- Allow an unapproved manual review to prepare fresh suggestions after OCR or model changes, preserving the old review and requiring a new filing approval. Retain Inbox navigation and pending field safeguards.

## 0.15.2

- Increase scanned-page OCR raster resolution for small text while retaining bounded raster size, timeouts, source bytes and page order.

- Count only files currently present in the Inbox. Keep trashed duplicates and superseded uploads in Activity history, and keep the two totals separate during refresh.

## 0.15.1

- Preserve long OCR/preparation responses across normal login renewal only after the companion verifies the same account, server and Space. Workspace changes still discard stale responses.
- Refresh the authenticated connection between batch documents. Expired or revoked access holds the queue without consuming document attempts or failing every remaining upload.

## 0.15.0 — 2026-11-01

- Prepare a manual review when AI evidence, dates or model capacity prevent verified suggestions. Rejected facts are omitted; a person must supply and approve the exact filing destination and tags.
- After an OCR attempt, pages still unreadable can be reviewed visually with explicit manual filing details. OCR-off inputs continue to require text recognition.
- Manual reviews cannot be automatically filed; source identity, revision, bytes, destination collisions and approval digests are checked normally.

## 0.14.13 — 2026-11-01

- Use saved taxonomy and language guidance once, without conflicting default-folder instructions.
- Restore the actual source quote when only extraction whitespace differs and there is exactly one matching span; changed text, digits and ambiguous matches remain held.
- Ask for printed document titles and complete printed dates, and identify nonliteral fact fields during the one bounded correction attempt.
- Allow an unsupported date format one correction attempt while retaining strict source evidence and date validation.

## 0.14.12 — 2026-11-01

- Offer Retry for scans waiting for OCR, using the same retry eligibility as bulk controls. Hide automatic filing actions while preparation is incomplete or no automatic steps are enabled.
- Separate Status and Stage in Activity so the processing milestone is distinct from attention or completion state.

## 0.14.11 — 2026-11-01

- Clear the retry confirmation when a fresh result arrives and avoid repeating an older OCR instruction beside the current diagnosis.

## 0.14.10 — 2026-11-01

- Clear the previous attention warning after an accepted retry, and watch the new attempt without reloading the document.
- Open the new review when retry succeeds; show a fresh diagnosis if it fails. Monitoring respects document navigation, source revisions and unsaved edits.
- Show processing with OCR disabled as Custom so the disabled text recognition step remains visible.

## 0.14.9 — 2026-11-01

- Sort every Inbox column in either direction; separate document status from processing stage.
- Restore exact cited source spans when PDF layout adds spaces inside names and dates, while rejecting changed non-space characters.
- Interpret bounded Japanese era dates through extensible language-pack calendar data, including saved packs.
- Explain evidence and date validation holds, and allow one validated local-model correction attempt.

## 0.14.8 — 2026-11-01

- Preserve unchanged document attention details when a compact status response omits them; fresh job data still clears resolved issues.

## 0.14.7 — 2026-11-01

- Keep the opened document and its attention banner stable during status refreshes and retries.
- Refresh a saved review directly instead of repeatedly reloading the full nested inbox.

## 0.14.6 — 2026-11-01

Activity shows full-queue document counts and Pause/Resume, Retry all and Cancel all controls, plus selected-item retry/cancel across loaded pages. Counts and bulk actions cover all nested imports, including records beyond the visible page. Cancellation preserves uploads and completed work; uncertain filing decisions remain available for individual verification. Queue pause and cancellation survive restarts.

Inbox lists files from the configured subfolders in one table, with folder paths and full import totals. Inbox and Activity show recorded five-step progress. Document details explain processing holds with a next action and retry control; new failures retain a safe diagnosis. Unsupported formats stay visible with a PDF conversion notice.

Processing history continues refreshing after Load more. Explicit retry now retries the saved failed proposal even when its attempt count has been reset. New queue controls are translated into all five UI languages.

## 0.14.5 — 2026-10-31

First public source/release preparation, including matching Web and companion installation packages, build instructions, licenses, dependency inventory and an OpenCloud catalogue contribution draft.

The latest UI changes align Settings widths and heading hierarchy, group OCR actions, present pattern tokens as reference material and align field/tag remove actions. Recent changes also add the visible version, clearer folder explanations, configurable filing categories and clearer interpretation/tag settings.

This release includes the PDF Inbox/review/automatic filing workflow, custom fields and tags, local or explicitly configured hosted AI, managed OCR languages, unattended App Token connections, OpenCloud backups, themes and five UI languages. See README.md for supported scope and remaining compatibility limitations.
