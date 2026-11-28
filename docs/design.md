# Document Workflow design

## Purpose and users

Document Workflow adds intake, review and filing to OpenCloud. The primary
journey is for a person who manages a document inbox in a Space. A separate
administrator installs the extension and companion. These role assumptions
describe the current workflow, not a claim about who has adopted the app.

## Navigation and review

- [Workspace shell](../src/components/WorkspaceShell.vue) keeps **Inbox**,
  **Documents**, **Activity** and **Settings** in a fixed order. The routes and
  detail entry points are in [routes.ts](../src/routes.ts).
- **Inbox** shows incoming files and their status. Open a file to compare the
  proposed name, destination and fields with the original. Put related evidence
  and decisions together. Keep the original document available while reviewing.
- **Documents** shows filed items. **Activity** shows processing attempts and
  outcomes. **Settings** configures intake, metadata, OCR, optional AI and
  appearance. Separate setup controls from routine document decisions.
- Use explicit text for missing data, a hold, an error and completion. Do not
  show a submitted action as complete before verification. Keep retry and manual
  review distinct. Do not hide a disabled operation's reason when it is needed
  for recovery.

## Visual identity

Proposed description of the current design: a quiet, document-first OpenCloud
workspace. Use OpenCloud's navigation conventions and neutral surfaces. Use the
app's teal accent to identify key controls without copying OpenCloud product
branding. The app is independent, not an official OpenCloud product.

- Use the system type in [styles.css](../src/styles.css). The primary actions
  and selected navigation use the teal family in [theme.css](../src/theme.css).
  Keep warning, danger and success colors in their semantic roles, with a text
  label. Do not use a status color as decoration or the only status cue.
- [theme.css](../src/theme.css) controls the app's semantic colors and maps
  compatible surfaces to OpenCloud roles when the effective modes match.
  [theme.ts](../src/state/theme.ts) supports system, light and dark appearance;
  the system choice follows the browser's OS preference. An explicit mode
  opposite to the host uses the app's fallback colors.
- [index.ts](../src/index.ts) supplies the host app-menu name, teal color and
  `file-text` icon identifier. The host renders that icon. The shell uses
  the text name, not a separate wordmark. Do not ship another logo to replace
  the host icon without a reason.
- [Cover source](../deploy/cover.svg) is the editable 1200 × 800 artwork for
  distribution, not a screenshot or app-menu icon. The source artwork carries a **Beta** label. Check the channel before using it for a release.
  The [packaging notes](STORE_PACKAGING.md) describe the release contents.
  The [artwork notice](../deploy/screenshots/LICENSE.md) covers the cover
  and the supplied captures.
- Real demo captures in this source baseline show [Inbox](../deploy/screenshots/1.jpg),
  [review](../deploy/screenshots/2.jpg), [dark library](../deploy/screenshots/3.jpg),
  [processing settings](../deploy/screenshots/4.jpg), [Activity](../deploy/screenshots/5.jpg)
  and [light library](../deploy/screenshots/6.jpg). The files are 1440 × 960
  and use fictional documents. Exact capture build and viewport are not
  recorded here. For a new release, check the current interface at each supported width.

OpenCloud Web is the platform reference for host navigation and controls.
Paperless-ngx and Papra inspired the workflow, not the artwork. Use proximity
to keep evidence beside its decision. Start with the primary action and put
advanced configuration in Settings to limit the choices during routine filing.

## Access, privacy and recovery

The app uses semantic links and named navigation, and [styles.css](../src/styles.css)
applies focus indicators and adaptive layouts. Keep the current visual and
reading order consistent with keyboard navigation. Support long file names,
empty lists, application errors and text scaling. A browser screenshot does
not demonstrate WCAG 2.2 AA conformance.

OpenCloud owns file permissions and data. Use review-first processing for a
new inbox. Local OCR can run without AI. Hosted AI requires explicit
configuration and consent; do not silently route data to a different provider.
See [architecture](ARCHITECTURE.md) and [processing safety](PROCESSING_SAFETY.md)
for the boundaries and recovery behavior.

## Validation

Use the [synthetic setup](LIVE_TESTING.md) and open each main page with a
fictional document. Compare light, dark and system appearance in both native
and demo surfaces as applicable. Check broad and narrow layouts at the CSS
breakpoints and include a long filename, an empty list and a review hold.
Check keyboard order, focus visibility, announced errors, contrast, reflow
and a screen reader. Record the build, environment, viewport, theme, setup
and screen state with each new capture. Refresh linked evidence and the source
inventory in the same change when visual identity changes.
