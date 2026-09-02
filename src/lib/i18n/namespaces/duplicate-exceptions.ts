/**
 * Same-English-different-meaning exceptions for the no-duplicates guard
 * (AQU-511 / AQU-832).
 *
 * The guard in `no-duplicates.test.ts` compares English strings, so it cannot
 * see meaning — but identical English does not always mean identical
 * translation. A breadcrumb's overflow affordance and a menu's overflow
 * affordance are both "More" in English and are routinely different words
 * elsewhere, so collapsing them onto one key would force one translation to
 * be wrong. That is the exact failure this catalog exists to prevent, so the
 * exception is real.
 *
 * Pulled into its own module (AQU-832 relaxation) so the exceptions are a
 * reviewable artifact in their own right rather than inline test fixture —
 * see docs/I18N-CONTEXT-CATALOG.md "why this changed".
 *
 * Default is deny: adding an entry here is a deliberate, reviewed act and the
 * reason must say why the two strings cannot share a translation. If the
 * reason is only "they happen to differ in code", reuse the shared key
 * instead. It is never a reason that the English differs in case — three of
 * the four target locales have no letter case at all, so a case-only split is
 * pure duplicate work. What does count is a difference the target language
 * must be free to express: a nominalized heading against an imperative
 * button, an accessible name that must not carry a continuation mark, a term
 * of art against an everyday verb.
 *
 * A trailing ellipsis/colon alone is NOT a reason either, as of the
 * `normalize()` fix below: `no-duplicates.test.ts` used to strip a trailing
 * `…`/`:` before comparing, which meant an aria-label and its own
 * placeholder ("Search" vs "Search…") collided on nothing but that mark and
 * needed an exception to stay apart. `normalize()` no longer strips it, so
 * those pairs simply don't collide anymore — 20 of the 30 entries this file
 * used to carry existed only for that reason and were removed rather than
 * left to rot (see "keeps every documented exception real" in
 * `no-duplicates.test.ts`, which rejects a stale entry for a key that no
 * longer collides). The 10 that remain are genuine meaning splits.
 */
export const DUPLICATE_EXCEPTIONS: Record<string, string> = {
  "importExport.dialog.characterPreviewHeading":
    "Noun heading over the list of characters an audio export will produce — " +
    "'the preview', a thing on screen. common.preview is the imperative button " +
    "that plays a clip back and swaps to common.pause while it runs. A heading " +
    "and a command are different parts of speech and most target languages " +
    "write them differently; folding them together would make one of the two " +
    "wrong wherever they diverge.",
  "importExport.dialog.audioSectionTitle":
    "Title of the export dialog's .zip card, naming a KIND OF DELIVERABLE the " +
    "user is about to download. nav.lens.audio names the editor's Audio lens — " +
    "a mode you switch into — and its own context pins it as shared by every " +
    "entry point that toggles that lens so the name can never drift. Reusing it " +
    "here would tie a file-format label to a UI mode's name, and a later edit " +
    "for one would silently change the other.",
  "nav.sidebarSection.more":
    "Expands a collapsed sidebar section. common.moreBreadcrumbs is screen-reader " +
    "text for a truncated breadcrumb path — 'more of this path' vs 'expand this " +
    "group' are different acts and diverge in most target languages.",
  "audio.library.moreTooltip":
    "Overflow-menu tooltip in the voice library, i.e. 'more actions'. Distinct " +
    "from common.moreBreadcrumbs ('more of this path') for the same reason.",
  "nav.outbox.eventEdit":
    "Names a queued operation in the outbox feed, beside noun-phrase siblings " +
    "('New cell', 'Delete comment', 'Attach audio'). common.edit is the imperative " +
    "button that starts editing. Languages that nominalize operation names would " +
    "write these differently, and one of them would be wrong.",
  "nav.historyControls.back":
    "Accessible name of the browser-style back arrow in the app header: return to " +
    "the previously visited page. common.back is the 'previous step' button inside a " +
    "dialog or wizard. Navigation history and step order are separate senses and " +
    "take different words in many languages.",
  "nav.outbox.eventValidate":
    "Names a queued operation in the outbox feed, in the same noun-phrase register " +
    "as its siblings. editor.selection.validate is the imperative toolbar button " +
    "that performs the sign-off. Operation name vs command; they diverge wherever " +
    "operation names are nominalized.",
  "audio.newVoice.kokoroLabel":
    "Field label for the Kokoro speaker dropdown in the New voice modal — which " +
    "built-in voice this engine should speak with. editor.navTitle.voice is the " +
    "editor's own audio-lens tab label naming a workspace mode. A form-field " +
    "label and a navigation tab are different UI roles that happen to share the " +
    "word 'Voice' and diverge in most target languages.",
  "audio.newVoice.mmsLanguageLabel":
    "Names the spoken language the MMS engine should synthesize. common.language " +
    "labels the switcher that changes the language of the interface itself. Two " +
    "unrelated referents that happen to share one English word; conflating them " +
    "would mislabel one of the two controls.",
  "importExport.dcs.languageFilterLabel":
    "Labels the form field naming the CONTENT language being searched for in an " +
    "external resource catalog — the language of the Bible resource, a piece of " +
    "data. language.label is the accessible name of the control that changes the " +
    "language of the interface itself. This is the same content-vs-interface split " +
    "already recorded above for audio.newVoice.mmsLanguageLabel, and several " +
    "target languages also distinguish an editable filter field's label from " +
    "interface chrome and from a table column heading.",
  "importExport.dcs.ownerFilterLabel":
    "Here Owner means the organization ACCOUNT that publishes a resource on an " +
    "external repository host — a namespace, not a person's standing in this " +
    "product. common.role.owner is the top rung of the permission ladder, whoever " +
    "has full control of a project. Unrelated referents that English spells the " +
    "same; languages that borrow a repository-hosting term for one and a " +
    "governance term for the other need both.",
  "editor.state.empty":
    "A cell-status word read mid-phrase inside the editor's accessible name ('… " +
    "empty'), alongside 'draft' and 'validated'. audio.recordingModal.emptySource " +
    "is a standalone placeholder meaning 'this line has no source text'. A status " +
    "adjective in a list and a standalone sentence fragment inflect differently.",
  "editor.expansion.recording":
    "The NAME of the tab holding a line's audio — a noun, 'the recording'. " +
    "audio.recordingModal.recordingStatus is the present participle shown beside a " +
    "pulsing dot while the microphone is live. Noun vs progressive verb: English " +
    "spells both 'Recording', almost nothing else does.",
  "auth.signup.usernameLabel":
    "Labels the account identifier being chosen at sign-up and sent to the identity " +
    "server — the name this person will type to sign in from then on. " +
    "projectSettings.user.usernameLabel labels the local author name recorded " +
    "against edits in a project's history, a per-device display preference that " +
    "never authenticates anything. Languages that distinguish a chosen login " +
    "handle from a displayed personal name need the two separately.",
  "auth.login.submitDefault":
    "The submit button of the sign-in form. auth.login.title is the heading naming " +
    "the whole form. Languages that nominalize headings ('Anmeldung') while keeping " +
    "buttons imperative ('Anmelden') need both, and English's coincidence hides it.",
  "search.mode.replace":
    "Names the find-and-replace mode, a term of art paired with 'Find' and usually " +
    "fixed by local software convention. audio.clone.replaceButton is an everyday " +
    "imperative that swaps an attached reference clip for another file.",
  "editor.milestone.vocab.startLabel":
    "Names the synthetic first division in the milestone navigator — a noun for " +
    "'the beginning of the file'. audio.recordingModal.startButton is the " +
    "imperative button that begins recording. Noun vs verb; several target " +
    "languages spell the two differently even though English collapses them.",
  "editor.sync.paused":
    "The app pausing an idle websocket connection while the tab is hidden, and " +
    "resuming it automatically. autopilot.status.paused is a person deliberately " +
    "pausing an autopilot run. Automatic vs deliberate pausing are different " +
    "concepts a translator would render with different verbs in most languages.",
  "autopilot.proposal.applying":
    "Transient label of the Apply button on a staged agent proposal while the " +
    "approved events are written to the outbox. search.replace.applying is the " +
    "find-and-replace panel rewriting matched cells, and nav.fileMenu.applying is " +
    "diarization results being written back. Three unrelated async operations that " +
    "share one English gerund; nothing ties their wording together.",
  "autopilot.proposal.applyFailed":
    "Error label when writing an approved agent proposal's events failed, so nothing " +
    "was saved and the user can retry. importExport.ebible.applyFailed is an eBible " +
    "corpus import failing to apply a downloaded delta. Approving someone else's " +
    "staged edits and importing a corpus are different acts, and the object of " +
    "'apply' differs, which several target languages spell differently.",
  "nav.fileMenu.applying":
    "Transient state of the file-options-menu 'Diarize' item while its speaker-" +
    "detection results are being written back to cells. search.replace.applying " +
    "is the transient state of the unrelated find-and-replace panel's Apply " +
    "button while it rewrites matched cells. Two independent async operations " +
    "that happen to share an English gerund; nothing ties their wording together.",
  "autopilot.proposal.apply":
    "Imperative button that commits every supported event in a staged agent proposal. " +
    "terminology.lookup.applyButton applies one selected glossary rendering to an " +
    "editor cell. English uses the same generic verb, but the operations and their " +
    "objects are distinct and may be translated differently.",
  "terminology.editor.showArchived":
    "Toggle revealing archived (deprecated) GLOSSARY TERMS in the termbase editor. " +
    "editor.lane.showArchived is a menu item revealing retired LANGUAGE LANES in the " +
    "lane switcher. Both happen to read 'Show archived (N)' in English, but a term " +
    "and a language lane are unrelated referents — a translator free to choose a " +
    "noun for 'archived' would not necessarily pick the same word for both.",
  "terminology.violations.kindMissing":
    "Chip tag on one infraction row in the terminology violations inbox: the " +
    "source bears a concept but the target lacks an approved rendering. " +
    "autopilot.readiness.level.missing is a checklist item's readiness state " +
    "('Missing' / 'Partly set up' / 'Ready') in the autopilot setup inspector. A " +
    "per-infraction tag and a setup-checklist state are different referents that " +
    "happen to share one English adjective.",
  "terminology.common.statusApproved":
    "Lifecycle-status badge on a glossary CONCEPT (draft → active → deprecated) — " +
    "'active' concepts read 'approved' next to 'suggested'/'old'. " +
    "autopilot.evidence.status.approved is the review status of a piece of AI-" +
    "gathered EVIDENCE in the autopilot readiness inspector (vs superseded/archived/" +
    "unknown). A controlled-vocabulary review state and an evidence-item review " +
    "state are different referents that happen to share one English adjective.",
  "terminology.common.statusSuggested":
    "Lifecycle-status badge on a glossary CONCEPT (draft → active → deprecated), " +
    "shown next to 'approved'/'old' on the term detail header. " +
    "autopilot.draft.suggested badges an individual AI-drafted CELL proposal " +
    "awaiting accept/dismiss. A controlled-vocabulary review state and a per-cell " +
    "AI-authorship marker are different referents that happen to share one English " +
    "adjective.",
  "nav.lens.audio":
    "Standalone tab label of the header Text/Audio segmented lens switch — a " +
    "primary navigation control read on its own, alongside its sibling 'Text'. " +
    "nav.outbox.previewAudio is a one-word fallback preview for an audio-attach " +
    "event row deep in the outbox diagnostics popover, standing in for a missing " +
    "text body among noun-phrase siblings like 'edit {id}'. A standalone control " +
    "name and a placeholder noun in a technical log read as different parts of " +
    "speech in languages that mark that distinction; the English capitalization " +
    "difference is incidental, not the reason (a case-only split alone would not " +
    "justify this entry).",
  "org.orgHome.table.languageHeader":
    "Column heading over the source→target language pair of each project row. " +
    "language.label is the accessible name of the UI-LANGUAGE switcher — the " +
    "language the interface itself is drawn in, a different thing entirely from " +
    "the languages a project translates between. Collapsing them would make a " +
    "translator render this column with interface-language wording, which is " +
    "wrong for a content column, and several languages distinguish the two " +
    "senses lexically rather than by context.",
  "org.addLanguagePopover.triggerLabel":
    "Visible text of a small chip BUTTON beside a project row that opens the " +
    "add-a-language-lane popover; it names an action's object, not a heading. " +
    "org.orgHome.table.languageHeader is the noun heading of a table column, and " +
    "language.label names the interface-language switcher. Button object, column " +
    "heading, and interface-chrome name take different forms in languages that " +
    "inflect for grammatical role, so one shared string cannot serve all three.",

  // -- AQU-511/AQU-832 org-namespace dedupe (WS-11) --------------------------
  // The org.ts sweep left 41+ keys re-minting English another namespace (or
  // org.ts itself) already had. Most were genuine dupes and got deleted in
  // favor of the existing key; the entries below are the ones a close read
  // showed carry a real meaning split, so both sides stay.
  "editor.ebible.selectAll":
    "A tiny underlined LINK that ticks every matched verse in the eBible import " +
    "review flow — an imperative select-all action. org.orgHome.statusFilter.all " +
    "(reused for the org project-status filter, the TeamsList visibility filter, " +
    "and the ProjectOverview lane picker) is the resting VALUE of a segmented " +
    "filter meaning 'no filter applied' — a noun-like option, not a command. " +
    "Imperative verb vs. filter-option noun take different forms in most " +
    "languages, so collapsing them would mislabel one of the two.",
  "org.orgHome.table.validatedHeaderLabel":
    "Nominal column heading over a stat/table cell (paired with 'Filled', " +
    "'Total', 'Words' as sibling headings, and reused as a StatTile label) — a " +
    "noun naming a metric. editor.state.validated is the lower-case per-cell " +
    "status word reused in badges and screen-reader names (contrasts with " +
    "'unvalidated', and is now also reused for the ProjectOverview chart-legend " +
    "swatch label). A title-case table heading and a lower-case status adjective " +
    "read as different parts of speech in languages that inflect for that, so " +
    "one shared string would be wrong for one of the two roles.",
  "org.projectOverview.legendTranslated":
    "Lower-case label read beside a colored swatch in a chart legend ('● " +
    "translated'), functioning adjectivally — it describes what the color means, " +
    "the same register as editor.state.validated/unvalidated. " +
    "org.orgHome.table.translatedHeaderLabel is the nominal, title-case column/" +
    "stat heading naming the same metric. A legend's adjectival state word and a " +
    "table's nominal heading take different forms in many languages, mirroring " +
    "the validated/legendValidated split right above it in this catalog.",
  "org.teamDetail.selectedCount":
    "Structurally different from editor.selection.count, not just differently " +
    "worded: this key is a plural({one, other}) MessageValue so languages with " +
    "real plural rules (Polish, Russian, Arabic, …) can render '1 selected' vs " +
    "'5 selected' with different words, while editor.selection.count is a single " +
    "fixed string with no plural branching. Reusing the editor key would " +
    "silently drop plural support for the TeamDetail add-member combobox trigger " +
    "in every language that needs it — a translatability loss, not a style " +
    "choice, and editor.ts is out of scope here to add plural support to it.",
  "org.overviewLaneTable.openAction":
    "Capitalized imperative BUTTON/link text ('Open') that navigates into a " +
    "project lane's editor — an action a person takes. comments.status.open is " +
    "a lower-case adjectival status badge on a comment thread ('this thread is " +
    "open'), matching the visual weight of its sibling comments.status.resolved. " +
    "Imperative verb vs. adjectival status take different forms in most " +
    "languages, so one shared string would be wrong for one of the two roles.",
  "org.projectOverview.columnApproved":
    "Plain column heading over a raw cell count in the per-file breakdown table " +
    "(sibling of 'Filled', 'Total', 'Words') — no review workflow implied, just " +
    "a count of cells marked approved. autopilot.evidence.status.approved is one " +
    "member of a stable enum of an AI agent's evidence-review lifecycle " +
    "(Proposed/Applied/Rejected/Superseded/Approved/Archived/Unknown), a term of " +
    "art for that specific workflow. A generic count-column heading and a named " +
    "state in a review pipeline are different concepts that happen to share an " +
    "English participle; collapsing them would leak review-workflow wording into " +
    "a plain stats column in languages that lexicalize the two differently.",
  "org.orgSidebar.archived":
    "Sidebar nav-link text AND breadcrumb section name for the org's permanent " +
    "archived-projects route — a page/section identity, the same grammatical " +
    "role as the editor.navTitle.* page titles it sits beside in the sidebar. " +
    "autopilot.evidence.status.archived is a lifecycle state of one piece of AI " +
    "evidence in the same stable status enum as .approved above. A destination " +
    "name and an item's lifecycle status are different concepts sharing one " +
    "English participle; several languages would render a place-name and a " +
    "state-of-an-item differently.",
  "org.membersPage.orgPage.unknownInviter":
    "Lower-case filler substituted into the middle of a byline sentence ('by " +
    "{username}') when the inviter is unavailable — grammatically the object of " +
    "a preposition, not a standalone word. autopilot.evidence.status.unknown is " +
    "a capitalized, standalone member of the evidence-status enum discussed " +
    "above (also reused for org.teamDetail's unknown-role fallback, a role-badge " +
    "context). A lower-case mid-sentence filler and a capitalized standalone " +
    "enum/badge value take different forms in languages that case- or " +
    "register-mark that distinction.",
  "org.membersPage.addMemberHeading":
    "Static <h2> SECTION HEADING introducing the add-member area of the " +
    "per-project Members page — a nominal label naming what's below it. " +
    "org.teamDetail.addMemberButton is the imperative text of an actual clickable " +
    "button/menu item that starts the add-member flow. This is the same " +
    "nominalized-heading-vs-imperative-button split already documented for " +
    "auth.login.title vs auth.login.submitDefault above: languages that " +
    "nominalize headings while keeping buttons imperative need both forms even " +
    "though English spells them identically.",
  "org.membersPage.orgPage.noExpiry":
    "Lower-case inline status caption ('no expiry') standing in for a computed " +
    "relative-time phrase on a pending-invite row, in the same register as its " +
    "lower-case sibling org.membersPage.orgPage.expired — a sentence fragment, " +
    "not a menu choice. org.membersPage.expiryNone is a Title-Case SELECT-MENU " +
    "OPTION ('No expiry') alongside sibling options '1 day', '7 days (default)', " +
    "'30 days' in the invite-link expiry dropdown. A dropdown choice and an " +
    "inline status sentence fragment are read as different grammatical roles in " +
    "many languages, so one shared string would fit only one of the two spots.",
  "org.memberAccessPanel.viaOrgRoleLabel":
    "Lower-case fragment ('org role') comma-joined into org.memberAccessPanel." +
    "alsoViaNote's 'Also via {paths}' sentence alongside 'team \"X\"' and " +
    "'project creator' — an inline list item, not a standalone label. " +
    "org.inviteByEmail.roleLabel is the Title-Case form-field label ('Org role') " +
    "above a role <select> in the invite-by-email dialog. A comma-joined lower- " +
    "case list fragment and a standalone form label take different forms in " +
    "most languages, so one shared string would be wrong in one of the two " +
    "positions.",
  "org.membersPage.sourceProjectCreator":
    "Lower-case fragment ('project creator') from the parallel source* badge " +
    "set (sourceDirectInvite/sourceViaTeam/sourceViaOrg), always rendered as " +
    "one item in a small access-source badge on MemberAccessPanel, never alone " +
    "as an explanatory sentence. projectSettings.share.lockedHintCreator (WS-17 " +
    "wave-4 dedupe: the org-membersPage twin of this key was deleted and its " +
    "call sites now reuse projectSettings.share.lockedHintCreator directly) is " +
    "standalone, sentence-like TOOLTIP content ('Project creator') explaining " +
    "why a locked role control is disabled — read on its own, the short-form " +
    "sibling of org.membersPage.lockedHintOrgAccess's full sentence. A " +
    "standalone tooltip phrase and an inline badge fragment take different " +
    "forms in languages that mark that register distinction.",

  // AQU-832 (WS-14 project-settings/creation/sharing wave): each entry below
  // pairs a projectSettings.* key against a key in a namespace this wave is
  // forbidden to edit (audio/autopilot/editor/fileDetails/nav/search), so the
  // duplicate can only be resolved on this side. Within projectSettings itself
  // the equivalent same-string duplicates were consolidated onto one shared
  // key instead of excepted — see the namespace file's "AQU-832" comments.
  "projectSettings.sourceLink.modeClone":
    "Badge naming the AD-9 link-mode ('Clone' vs 'Live') on a linked project's " +
    "Source Link card, and reused for the same radio option in the create-project " +
    "dialog. audio.library.cloneEngineLabel names a voice-cloning TTS engine in " +
    "the Voice Studio's engine picker. A project-linking term of art and an " +
    "audio-engine brand-ish label that happen to share the English word 'Clone'.",
  "projectSettings.section.experimental":
    "Section/nav-group heading for this project's device-local experimental " +
    "feature flags. autopilot.settings.experimentalTitle is the same heading for " +
    "the unrelated Autopilot agent's own experimental-flags card. Two different " +
    "features' settings panels that both happen to be called 'Experimental'.",
  "projectSettings.info.targetLanguageLabel":
    "Field label on the Project Info card (and reused by the create-project " +
    "dialog) for the project's target language. autopilot.inspector.details." +
    "targetLanguage is a read-only detail row in the Autopilot run inspector " +
    "showing which language a specific run drafted into. A settings input label " +
    "vs a report-style detail-row label for the same underlying value read very " +
    "differently in languages that distinguish an editable field from a fact.",
  "projectSettings.decay.summary":
    "Collapsed-details summary for this project's AD-14 confidence-propagation " +
    "tuning (max hops / attention threshold). editor.expansion.retrievalSupport " +
    "is the cell-level badge shown on an individual cell's expansion panel. A " +
    "settings-panel heading and a per-cell status badge naming the same feature " +
    "at two different granularities read as different parts of speech.",
  "projectSettings.share.tabMembers":
    "Tab label in the Share dialog switching to the per-project member list. " +
    "editor.navTitle.members is the breadcrumb/nav title for the standalone " +
    "Members page. A tab within a dialog and a full page's nav title are " +
    "different UI roles that happen to share the plain noun 'Members'.",
  "projectSettings.breadcrumbEditor":
    "Breadcrumb trail segment in Project Settings linking back to the workspace " +
    "editor. editor.navTitle.editor is the editor's own nav-title/tab label when " +
    "it is the active surface. A link naming a DIFFERENT page vs a page naming " +
    "ITSELF are different grammatical roles in languages that mark that split.",
  "projectSettings.pageTitle":
    "Page heading of the Project Settings index. editor.navTitle.projectSettings " +
    "is the breadcrumb/nav label used while inside the editor to link TO " +
    "settings. A page naming itself vs a link naming its destination.",
  "projectSettings.section.editor":
    "Card heading for the settings group configuring the editor surface " +
    "(chapter paging). editor.navTitle.editor is the editor's own nav-title/tab " +
    "label when it is the active surface. A settings card naming the feature it " +
    "configures vs a page naming itself are different grammatical roles.",
  "projectSettings.section.voice":
    "Card heading for this project's Voice/TTS API-key configuration. " +
    "editor.navTitle.voice is the editor's own audio-lens tab label. A settings " +
    "card and a workspace lens switch that happen to share the word 'Voice'.",
  "projectSettings.sourceLink.modeLive":
    "Badge naming the AD-9 link-mode ('Live' vs 'Clone') on a linked project's " +
    "Source Link card, and reused for the same radio option in the create-project " +
    "dialog. editor.sync.live is the websocket-connection status indicator in " +
    "the editor's sync badge. A project-linking term of art vs a connectivity " +
    "status word that happen to share the English word 'Live'.",
  "projectSettings.section.languages":
    "Card heading for this project's target-language lanes. fileDetails.languages " +
    "is a plain data label in a file-info panel naming which languages a file " +
    "covers. A settings-card heading vs a file-metadata field label.",
  "projectSettings.backLinkLabel":
    "Back-link label returning from a settings sub-pane to the settings index, " +
    "and the breadcrumb trail's terminal 'Settings' crumb. nav.settings is the " +
    "left-sidebar navigation entry that opens settings in the first place. A " +
    "'go back to X' affordance and 'X' the sidebar destination read differently " +
    "in languages that distinguish a navigation link from the place it leads.",
  "projectSettings.section.terminology":
    "Card heading linking to this project's Terminology Library from within " +
    "Project Settings. nav.sidebarSection.terminology is the left-sidebar's own " +
    "top-level entry for the same destination. A settings-card link and the " +
    "primary nav entry it duplicates read as different UI roles.",
  "projectSettings.section.import":
    "Section heading for this project's USFM-import front-matter preference. " +
    "nav.workspaceActions.import is the imperative 'Import' button that starts a " +
    "new file import. A settings-card noun heading vs an action-triggering verb " +
    "button — languages that nominalize headings but keep buttons imperative " +
    "need both spelled differently even though English collapses them.",
  "projectSettings.share.copied":
    "Transient confirmation after copying a minted invite link's URL in the " +
    "Share dialog. nav.report.copied is the equivalent confirmation for the " +
    "unrelated diagnostics-report copy action. Two independent copy-to-clipboard " +
    "confirmations that happen to share the same short exclamation.",
  "projectSettings.section.bibleResources":
    "Card heading toggling this project's Bible-resources (bibletranslation.org) " +
    "integration on/off. search.mode.bibleTooltip is the tooltip on the search " +
    "panel's Bible-resources search-mode toggle. A settings on/off card heading " +
    "vs a tooltip naming a search filter mode for the same underlying dataset.",
  "importExport.landing.badgeBeta":
    "Per-format maturity pill on one import-option card on the landing screen " +
    "('this specific importer is beta'). nav.beta.badge is the app-chrome pill " +
    "for the whole product ('Aquilla itself is in beta') that opens a heads-up " +
    "dialog when clicked. A language that marks the scope of 'beta' (a single " +
    "feature vs. the whole application) would render these two differently.",
  "importExport.dialog.scopeLegend":
    "Field-group legend above the file/project scope toggle on the Export " +
    "dialog. dialog.assign.scopeLabel is the unrelated cast/voice-assignment " +
    "modal's scope selector (which camera angles an assignment applies to). " +
    "Two independent 'what does this apply to' concepts that only share the " +
    "English noun; a language that names the axis being scoped would diverge.",
  "importExport.landing.tn.title":
    "Import-format option title on the landing screen ('choose Translation " +
    "Notes as your import source'). editor.tn.title is the reference-panel " +
    "heading shown beside the cell being translated, once notes already exist " +
    "in the project. A picker label and a reading-pane heading are different " +
    "grammatical roles many languages would not render identically.",
  "importExport.dialog.andMore":
    "Truncation notice at the end of the export inline-style fidelity-warnings " +
    "list. editor.ebible.andMore is the unrelated truncation notice at the end " +
    "of the eBible target-import book preview list. Two independent 'n more' " +
    "counters in unrelated flows that only happen to share English wording.",
  "importExport.upload.categorySubtitles":
    "Format-category label ('Subtitles') in the main Upload files panel's " +
    "supported-formats legend. editor.timeline.laneSubtitle names the subtitle " +
    "track in the audio timeline editor. A format-picker category and a " +
    "timeline lane name are different parts of the UI that happen to share " +
    "the English noun.",
  "importExport.paratext.sourceTextTitle":
    "Card title on the Paratext preview screen offering 'import as source' " +
    "('Source text'). editor.source.textAria is the unrelated accessible name " +
    "for the source-column text region inside the cell editor. A choice-card " +
    "heading and an accessibility name for an existing pane serve different " +
    "purposes and different audiences (sighted vs. screen-reader users).",
  "importExport.dialog.voiceLegend":
    "Field-group legend above the cast-voice export filter on the Export " +
    "dialog ('Voice: <select>'). editor.navTitle.voice is the unrelated tab " +
    "title for the Voices panel in the editor's left dock. A filter-field " +
    "legend and a navigation-tab title are different UI roles.",
  "importExport.direction.targetLabel":
    "Form-field label on the post-import direction prompt, where the user " +
    "types the project's target language. autopilot.inspector.details." +
    "targetLanguage is the unrelated read-only detail-row label in the " +
    "autopilot run inspector. An editable field label and a read-only detail " +
    "row are different grammatical roles many languages would not share.",

  // -- AQU-511/AQU-832 wave-4 cross-namespace dedupe (WS-17) ------------------
  // Six area agents fanned out in parallel and independently minted keys for
  // the same English. Most of the resulting 61 collisions were genuine
  // duplicates and got deleted in favor of one shared key (reused directly, or
  // promoted to common.* — see common.ts's wave-4 block); the entries below are
  // the ones a close read showed carry a real meaning split, so both sides stay.
  "org.breadcrumb.organizationFallback":
    "Fallback heading text shown in the org breadcrumb/page title when the " +
    "active organization has no name yet. onboarding.apiTokens.orgLabel is the " +
    "Title-Case FORM FIELD LABEL above the org-picker <select> in the new-API-" +
    "token dialog. A placeholder standing in for a missing proper noun and a " +
    "field label naming what a control selects are different grammatical " +
    "roles, and several languages inflect a fallback name differently from a " +
    "field label.",
  "org.switcher.workspaceFallback":
    "Fallback name shown in the org switcher/breadcrumb when the active " +
    "organization has no name yet — same role as org.breadcrumb." +
    "organizationFallback above, for 'Workspace' instead of 'Organization'. " +
    "onboarding.preferences.workspace.groupLabel is the settings-group HEADING " +
    "in personal Preferences that titles the sidebar-layout/confirm-replace " +
    "section. A fallback placeholder name and a settings-section heading are " +
    "different grammatical roles that happen to share one English noun.",
  "org.orgHome.pendingInvitations.expiresOn":
    "Lower-case trailing clause spliced mid-sentence into a Pending-invitations " +
    "row (' · expires {date}'), read as a continuation of the sentence before " +
    "it — not a standalone label. common.expiresOn (WS-17 wave-4 promotion of " +
    "the identically-worded, Title-Case onboarding.apiTokens.expiresOn and " +
    "projectSettings.share.expiresOn, both standalone row text reading " +
    "'Expires {date}' on their own line) is capitalized and stands alone. A " +
    "mid-sentence lower-case clause and a standalone capitalized sentence take " +
    "different forms in most languages, mirroring this catalog's other " +
    "inline-fragment-vs-standalone-label splits (e.g. org.membersPage.orgPage." +
    "noExpiry vs org.membersPage.expiryNone, just above).",
  "org.membersPage.orgPage.expired":
    "Lower-case inline status word on a pending-invite row in the org-level " +
    "Members page, in the same register as its lower-case sibling " +
    "org.membersPage.orgPage.noExpiry — a sentence fragment, not a standalone " +
    "badge. onboarding.apiTokens.expiredBadge is a capitalized, standalone " +
    "shadcn Badge component on a personal API-token row. A lower-case inline " +
    "status word and a capitalized standalone badge take different forms in " +
    "languages that case- or register-mark that distinction.",
  "onboarding.preferences.profile.responseLanguage.label":
    "Field label in the personal Translator Profile (Preferences page) for " +
    "the language the AI assistant should use when replying to THIS person in " +
    "chat — a device-local, per-person override. projectSettings.ai." +
    "assistantLanguageLabel is the PROJECT-WIDE default for the same-named " +
    "setting, shared by everyone on the project, configured in Project " +
    "Settings' AI card. Same surface word, different scope and different " +
    "underlying data (personal profile field vs shared project setting) — " +
    "collapsing them would risk a translator conflating a personal override " +
    "with a shared team default.",
  "onboarding.preferences.hint.notSet":
    "Standalone Title-Case index-row hint on the Preferences page ('Not set'), " +
    "alongside sibling Title-Case hints 'Personal'/'On-device'/'Sharing on'. " +
    "projectSettings.advancedLlm.notSet is a lower-case fragment substituted " +
    "into the middle of the Advanced-LLM summary template ('Custom: {endpoint " +
    "or not set}'), never read on its own. A standalone Title-Case hint and an " +
    "inline lower-case template fragment take different forms in languages " +
    "that case- or register-mark that distinction.",
  "rules.editor.mode.forbidden":
    "One value of the fixed three-option RULE MODE enum (Forbidden/Required/" +
    "Must match) selected in RuleEditor's Mode field, describing how a " +
    "translation rule enforces its pattern. terminology.status.forbidden is " +
    "one value of the unrelated, six-component-wide RenderingStatus enum " +
    "(forbidden/alternate/required) describing a glossary term's lifecycle " +
    "status. Two independent fixed vocabularies that happen to share the " +
    "English word 'forbidden' for otherwise unrelated concepts.",
  "rules.editor.mode.required":
    "One value of the fixed three-option RULE MODE enum in RuleEditor's Mode " +
    "field ('Required' — Title Case, sibling of 'Forbidden'/'Must match'), " +
    "describing how a translation rule enforces its pattern. terminology." +
    "status.preferred is 'required' (lower-case) in the unrelated " +
    "RenderingStatus enum, naming a glossary term's preferred/mandatory " +
    "rendering. Different case AND different fixed vocabularies (rule-" +
    "enforcement mode vs term lifecycle status) that happen to share one " +
    "English word.",
  "org.teamDetail.addedColumn":
    "Nominal table-column heading (and DateTooltip hover prefix) for the timestamp " +
    "a project or person was added to a team, sibling of Name/Role. onboarding." +
    "checklist.invite.addedPrefix is the past-tense VERB that starts the invite-step " +
    "confirmation sentence 'Added {name} as contributor.' A date-column heading " +
    "and a sentence-initial verb take different forms in many languages " +
    "(nominalized date label vs. finite verb), so one shared string would be " +
    "wrong for one of the two roles.",
  "org.teamDetail.detachButton":
    "Routine, reversible action in TeamDetail: unlinks a project from a team's " +
    "access-grant list with a single click, no confirmation dialog — the " +
    "project can be re-attached just as easily. projectSettings.sourceLink." +
    "detachConfirmButton is the confirm button of an irreversible, typed-" +
    "confirmation dialog (see projectSettings.sourceLink.irreversibleTitle/" +
    "typeToConfirm) that permanently severs a project's live upstream-source " +
    "link and snapshots its data. A casual toggle and a one-way destructive " +
    "operation carry very different weight, and many languages would render " +
    "'detach' with a stronger verb for the latter.",
  "terminology.editor.errorImportFailed":
    "Failure notice for importing TERMS into the project termbase — a glossary " +
    "operation. importExport.errors.importFailed reports a failed SOURCE-DOCUMENT " +
    "import, the parse-and-ingest pipeline. common.test.ts already documents " +
    "'Import' as a verb whose translation depends on its domain, and these are two " +
    "different domains; one shared sentence would misname one of them.",
  "terminology.livingMemory.translationAria":
    "Accessible name of the field holding a single stored translation in the " +
    "living-memory list — a countable noun, 'this translation'. " +
    "importExport.upload.categoryTranslation names a FILE CATEGORY in the upload " +
    "picker, sitting beside 'Source' and 'Audio' as a kind-of-thing label. A " +
    "specific instance and a category name take different forms wherever nouns " +
    "inflect for definiteness.",
  "importExport.paratext.languageLabel":
    "Labels the SOURCE LANGUAGE detected in a Paratext project during import — a " +
    "property of the file being read. autopilot.inspector.run.lane names the " +
    "language LANE an Autopilot run targeted, i.e. which translation track the " +
    "run wrote into. One describes an input's language, the other identifies a " +
    "destination track; languages that mark that difference with case or an " +
    "adposition cannot share a single rendering.",
  "agent.approve":
    "Imperative button that accepts a translation agent's staged, human-gated " +
    "proposal (a changeset, a memory, or a brief update) — reused across the " +
    "agent workbench, the changeset approval gate, and the memory/brief review " +
    "queues, all the same act. rules.surface.approveButton is the unrelated " +
    "button that promotes a project-level translation rule up to org scope. Two " +
    "independent human-gate actions that happen to share the English verb " +
    "'Approve'.",
  "agent.memory.tabApproved":
    "Tab-trigger heading over the list of already-approved agent-authored " +
    "memories, in the translation-agent's Memory tab (paired with sibling tabs " +
    "'Proposed' / 'Project brief') — the counterpart split to agent.memory." +
    "tabProposed just below, against the same unrelated autopilot evidence-" +
    "status enum documented at org.projectOverview.columnApproved above.",
  "agent.memory.tabProposed":
    "Tab-trigger heading over the queue of agent-authored memories awaiting human " +
    "review, in the translation-agent's Memory tab (paired with sibling tabs " +
    "'Approved' / 'Project brief'). autopilot.evidence.status.proposed is one " +
    "value of the fixed, unrelated evidence-review lifecycle enum (Proposed/" +
    "Applied/Rejected/Superseded/Approved/Archived/Unknown) in the autopilot " +
    "readiness inspector, the same kind of split already documented for " +
    "terminology.common.statusApproved vs autopilot.evidence.status.approved " +
    "above. A tab heading naming a queue and one fixed value of an unrelated " +
    "status enum happen to share one English participle.",
  "agent.workingSet.openLink":
    "Lower-case imperative LINK text in the agent workbench's working-set row that " +
    "jumps the editor to that cell ('open' — a shortened 'open in editor'). " +
    "comments.status.open is a lower-case adjectival status badge on a comment " +
    "thread ('this thread is open'), the same split already documented for " +
    "org.overviewLaneTable.openAction above. Imperative verb vs. adjectival status " +
    "take different forms in most languages, so one shared string would be wrong " +
    "for one of the two roles.",
  "org.accessModelLegend.creator.label":
    "Title-Case, standalone table-cell value in AccessModelLegend's grant-path " +
    "table, sibling of 'Direct'/'Via group'/'Org-wide' in the same column — a " +
    "grant-path NAME. org.memberAccessPanel.creatorGrantLabel is lower-case " +
    "'creator', one item comma-joined inline into a badge fragment alongside " +
    "'direct:'/'org:'/'team {name}:'. A standalone Title-Case table value and a " +
    "lower-case inline fragment take different forms in languages that case- or " +
    "register-mark that distinction, mirroring this catalog's other such splits " +
    "(e.g. org.membersPage.orgPage.expired vs onboarding.apiTokens.expiredBadge).",
  "org.membersMatrixView.memberColumnHeader":
    "Table column heading over the whole 'who' column of the members × projects " +
    "matrix (sibling of the project-name column headings beside it) — the NAME " +
    "OF A CATEGORY of table content. org.teamsList.memberBadge is a small pill " +
    "on a team card meaning 'the current viewer's own role in this team is " +
    "Member' — a role/STATUS VALUE, not a column name. A table heading and a " +
    "status badge take different grammatical forms in languages that mark that " +
    "distinction, mirroring this catalog's other heading-vs-badge splits.",
  "org.membersPanel.sourceViaGroup":
    "Lower-case inline badge fragment next to a username in MembersPanel's " +
    "roster row ('via group'), sibling register to org.membersPage." +
    "sourceViaOrg/sourceViaTeam on this same row. org.accessModelLegend." +
    "viaGroup.label is a Title-Case, standalone table-cell value in " +
    "AccessModelLegend's grant-path table, sibling of 'Direct'/'Org-wide' — " +
    "the same heading-vs-inline-fragment split already recorded for " +
    "org.accessModelLegend.creator.label just above.",
  "org.multiProjectInviteDialog.projectsFieldLabel":
    "Form-field label above a checklist of projects to invite someone to, in " +
    "the multi-project invite dialog — labels an in-dialog form control. " +
    "nav.projects is the primary left-sidebar navigation entry that opens the " +
    "whole projects list as a destination. A dialog field label and a nav " +
    "destination name read as different grammatical roles in languages that " +
    "distinguish an editable-form label from a place you navigate to, mirroring " +
    "this catalog's other field-label-vs-nav-entry splits (e.g. " +
    "projectSettings.section.terminology vs nav.sidebarSection.terminology).",
  "org.archivedProjects.deletedColumnLabel":
    "Title-Case table column heading (sibling of 'Project'/'Archived' in the " +
    "same admin table) AND the DateTooltip accessible label naming that " +
    "column's date — a heading naming a category. comments.file.deletedBadge " +
    "is lower-case 'deleted', a small inline status badge on a file reference " +
    "inside a comment thread. A table-column heading and a lower-case inline " +
    "status badge take different forms in languages that case- or register-" +
    "mark that distinction, mirroring this catalog's other such splits (e.g. " +
    "org.accessModelLegend.creator.label vs org.memberAccessPanel.creatorGrantLabel).",
  "org.overview.needsAttentionHeading":
    "Section HEADING on the org Overview page, titling a list of at-risk " +
    "projects (sibling of 'Pending invitations', reads as a page-region " +
    "name). autopilot.status.needsAttention is one value of a fixed-" +
    "vocabulary STATUS enum badging a single Autopilot readiness checklist " +
    "item (alongside 'Ready'/'Missing'/'Partly set up'). A section heading " +
    "and a per-item status badge are different grammatical roles that " +
    "happen to share one English phrase, mirroring this catalog's other " +
    "heading-vs-status-word splits.",
  "org.joinOrgPage.roleLine":
    "Second line of the org-invite preview card on JoinOrgPage, always written to " +
    "open a clause mid-register ('you'll join as …') even when it starts the " +
    "paragraph, because the same lowercase clause continues an 'Invited by X — ' " +
    "opener elsewhere on this same card. auth.join.roleLineSingle is a capitalized, " +
    "standalone sentence opener on the unrelated project-JoinPage summary card " +
    "('You'll join as …'). Not a bare case split: the org-invite card's own " +
    "inviter variant (auth.join.roleLineSingleInviter, reused directly here) is " +
    "byte-identical in both places precisely because register, not case alone, is " +
    "what's being preserved — collapsing this one onto auth.join.roleLineSingle " +
    "would put a capital letter mid-sentence the one time no inviter is known.",
  "org.joinOrgPage.roleLineEmail":
    "Email-bound sibling of org.joinOrgPage.roleLine, same lowercase mid-register " +
    "clause, same reasoning: auth.join.roleLineSingleEmail is the capitalized " +
    "standalone sentence opener on the unrelated project-JoinPage card.",
  "importExport.columnMapping.sourceColumnLabel":
    "Labels the SOURCE-TEXT column picker in the spreadsheet column-mapping " +
    "step during import — a form-field label naming which uploaded column " +
    "holds source text. editor.source.textAria is the accessible name of the " +
    "source-column text region inside the cell editor. A mapping-field label " +
    "and an accessibility name for an existing pane serve different purposes " +
    "and different audiences (sighted vs. screen-reader users).",

  // -- AQU-832 (Monday.com integration wave) -----------------------------
  "projectSettings.monday.orgSettingsLinkText":
    "Lower-case words spliced mid-sentence into projectSettings.monday." +
    "orgNotConnectedInstructions ('...connect it in organization settings, " +
    "or ask...'), read as a continuation of that sentence — sometimes plain " +
    "text, sometimes the visible text of an inline link, never read alone. " +
    "editor.navTitle.organizationSettings is a capitalized, standalone " +
    "sidebar/breadcrumb nav title ('Organization settings') naming a whole " +
    "page. A mid-sentence lower-case fragment and a standalone Title-Case " +
    "page name take different forms in languages that case- or " +
    "register-mark that distinction, mirroring this catalog's other " +
    "inline-fragment-vs-standalone-title splits (e.g. " +
    "org.membersPage.orgPage.noExpiry vs org.membersPage.expiryNone above).",
  "projectSettings.monday.applyButton":
    "Imperative button that commits the AI-proposed Monday column↔metric mapping " +
    "shown in the review panel. terminology.lookup.applyButton applies one " +
    "selected glossary rendering to an editor cell; autopilot.proposal.apply " +
    "commits every supported event in a staged translation-agent proposal. " +
    "Three unrelated 'apply a proposed change' operations across three " +
    "features that happen to share the generic English verb — the object " +
    "being applied differs in each, and several target languages would " +
    "translate the verb differently depending on that object.",
  "terminology.libraryStats.enforcedLabel":
    "Stat-tile HEADING above a percentage figure on the Terminology page's " +
    "summary panel — a title-case label naming what the number below it means. " +
    "terminology.termDetail.verdictEnforced is a lowercase inline VERDICT word " +
    "describing a single occurrence's outcome ('enforced' / 'infringed' / 'n/a') " +
    "in a table cell. A panel-heading noun and an inline verdict adjective are " +
    "different grammatical roles that many languages inflect or phrase " +
    "differently depending on which one they are.",
  "terminology.libraryStats.infringedLabel":
    "Stat-tile heading counterpart to terminology.libraryStats.enforcedLabel, " +
    "for the infringed-percentage tile. Distinct from " +
    "terminology.termDetail.verdictInfringed (lowercase inline verdict word) for " +
    "the same heading-vs-verdict reason documented on enforcedLabel above.",
  "terminology.conceptDialog.renderingPlaceholder":
    "Inline placeholder hint shown INSIDE an empty rendering-text input in the " +
    "add/edit concept dialog's renderings list — a terse, lowercase instructional " +
    "hint per normal placeholder convention. terminology.editor.renderingLabel is " +
    "a visible FIELD LABEL heading (title case) above a single-rendering input " +
    "elsewhere in GlossaryEditor. A heading noun and an inline instructional hint " +
    "are different grammatical registers that several languages phrase " +
    "differently (e.g. an imperative or truncated hint vs. a standalone noun).",
  "terminology.common.statusLabel":
    "Field/column label for a TERM's review status (draft/active/deprecated) in " +
    "the Terminology page's own add/edit-concept dialog and concepts table. " +
    "org.orgHome.projectsPanel.statusLabel is the column header for a PROJECT's " +
    "own status in the org-home projects table — an unrelated entity with its own " +
    "status vocabulary. Both happen to be the single English word 'Status', but " +
    "many languages lexicalize 'a term's review state' and 'a project's state' " +
    "differently, or decline the noun differently depending on the thing it " +
    "describes.",
  "rules.createDialog.descriptionLabel":
    "Visible field label above the free-text description input in the standalone " +
    "rule-creation dialog — a sighted user reads it beside the input. " +
    "nav.report.descriptionFieldLabel is a visually-hidden (screen-reader-only) " +
    "label for a bug-report textarea that shows a placeholder instead of a visible " +
    "label. A visible form label and an sr-only accessible name serve different " +
    "audiences and often take different phrasing (e.g. a visible label can be " +
    "terser since layout already implies context; an sr-only label must stand " +
    "alone).",
  "audio.voice.clear":
    "One of a fixed set of one-word Gemini TTS voice tone descriptions (see " +
    "audio.voice.bright) — an ADJECTIVE describing how a voice sounds ('distinct, " +
    "easy to make out'). common.clear is the imperative 'Clear' BUTTON that resets " +
    "a filter, search box, or field. Adjective vs. imperative verb read " +
    "differently in most target languages, so one shared string would be wrong " +
    "for one of the two roles.",
  "audio.voice.forward":
    "One of the same fixed set of Gemini TTS voice tone descriptions as " +
    "audio.voice.clear above — an ADJECTIVE describing a voice's personality " +
    "('direct, confident'). nav.historyControls.forward is the accessible name of " +
    "the browser-style forward-navigation arrow button — a NAVIGATION COMMAND, " +
    "unrelated in meaning. Several target languages would not use the same word " +
    "for 'go forward' and 'a forward manner of speaking'.",
  "audio.aiError.unknownTitle":
    "Fallback popover heading from categorizeAiError()'s heuristic AI-error " +
    "classifier (TTS/transcription/drafting failures), shown inline beside a " +
    "retry affordance. error.generic.title is the heading of a full-page error-" +
    "boundary screen shown when the whole app crashes. Distinct registers — an " +
    "inline popover heading and a full failure-screen title — mirroring the " +
    "audio.recordingModal.genericError vs error.generic.title split this " +
    "namespace's own context notes already document.",
  "agent.workingSet.outcome.rejected":
    "Lower-case state-stripe label on a decided working-set row (WorkingSetPanel), " +
    "sibling of its own '✓ accepted'/'✓ edited & accepted'/'↩ undone' outcome labels " +
    "on the identical stripe — a per-row record of what the reviewer just did with " +
    "one draft cell. autopilot.evidence.status.rejected is a capitalized value of the " +
    "unrelated, fixed evidence-review lifecycle enum (Proposed/Applied/Rejected/" +
    "Superseded/Approved/Archived/Unknown) badging a piece of AI-gathered evidence in " +
    "the Autopilot readiness inspector — the same heading/badge-vs-lowercase-status " +
    "split already documented elsewhere in this file (e.g. org.projectOverview." +
    "columnApproved vs autopilot.evidence.status.approved).",
  "agent.run.tool.stage":
    "Lower-case, font-mono technical label naming the 'emit' TOOL the agent called in " +
    "one run-timeline chip (AgentRunView) — staging draft events for review, sibling " +
    "of the equally terse 'sql'/'docs'/'read'/'examples'/'draft' tool-kind labels on " +
    "identical chips, the same class of split already documented for agent.run.tool." +
    "search/draft just below. importExport.dcs.stageFilterLabel is a capitalized " +
    "form-field LABEL above a picker choosing a DCS repository RELEASE MATURITY " +
    "(Latest/Pre-release/Production) in the import flow — an unrelated content-" +
    "pipeline concept that happens to share the English word.",
  "agent.run.tool.draft":
    "Lower-case, font-mono technical label naming which TOOL the agent called in one " +
    "run-timeline chip (AgentRunView), sibling of the equally terse 'sql'/'docs'/" +
    "'read'/'examples'/'search' tool-kind labels on identical chips — the same class " +
    "of split already documented for agent.run.tool.search just below. " +
    "autopilot.graph.node.draft is the capitalized caption of the drafting STAGE " +
    "in the Autopilot pipeline graph (and the review inspector's card title). A " +
    "lower-case technical chip label and a capitalized stage caption take " +
    "different forms in most languages.",
  "agent.run.tool.search":
    "Lower-case, font-mono technical label naming which TOOL the agent called in one " +
    "run-timeline chip (AgentRunView), sibling of the equally terse 'sql'/'docs'/" +
    "'read'/'examples'/'draft' tool-kind labels on identical chips. nav.search is the " +
    "capitalized nav-sidebar destination and dock tab-rail label that opens the " +
    "project's search feature — a navigation entry, not a tool-call badge. Case and " +
    "register both differ for the same reason: one names a place you navigate to, the " +
    "other names a machine-readable kind on a technical chip.",
  "agent.proposal.kind.edit":
    "Badge naming the KIND of a staged agent-authored proposal row ('target.cell." +
    "commit') in ProposalCard, a noun-phrase operation name read alongside sibling " +
    "kind badges 'New source row'/'New target row'/'Comment'/'Validate' on the same " +
    "row. common.edit is the imperative Edit button that starts editing a cell. The " +
    "same operation-name-vs-imperative-button split already documented for " +
    "nav.outbox.eventEdit above — a different feature (the outbox diagnostics feed) " +
    "with the identical register distinction.",
  "agent.proposal.kind.validate":
    "Badge naming the KIND of a staged agent-authored proposal row ('cell.validate') " +
    "in ProposalCard, the same noun-phrase operation-name register as its sibling " +
    "kind badges on that row ('Edit', 'Comment', …). editor.selection.validate is " +
    "the imperative toolbar button that performs the sign-off action itself. The " +
    "same split already documented for nav.outbox.eventValidate above.",
  "org.teamDetail.teamSettingsAriaLabel":
    "Accessible NAME of an icon-only gear Link on the team-detail header that " +
    "NAVIGATES to the team-settings page — a screen reader announces it as the " +
    "link's name with no visible text and no surrounding layout to lean on, so " +
    "several languages want a verb here ('Go to team settings' / 'Open team " +
    "settings'). settings.teamSettings.title is the PageHeader heading of the " +
    "destination page itself: a standalone noun phrase naming the page a user " +
    "has already arrived at. Same English words, different grammatical role — " +
    "the same navigate-vs-heading split already documented for the language " +
    "switcher in namespaces/language.ts.",
  "terminology.livingMemory.section.brief.title":
    "Index-row title naming the translation brief — the skopos document, a " +
    "translation-studies term of art that several languages render with a " +
    "loanword or fixed phrase. autopilot.graph.node.summarize shows 'Brief' as " +
    "the caption of the summarize STAGE in the autopilot pipeline graph — a " +
    "process-step label, not the document, and free to translate as 'summary'.",
  "terminology.livingMemory.section.brief.statusNone":
    "Hint on the Living Memory index saying the brief document has not been " +
    "begun — an authoring state of a document. autopilot.status.notStarted is a " +
    "value of the run-status enum for a background PROCESS that has not run " +
    "yet; document-authoring and process-lifecycle states often take different " +
    "verbs or participles.",
  "terminology.livingMemory.section.brief.statusDraft":
    "Hint on the Living Memory index saying the brief document is partially " +
    "filled in — a document maturity state ('a draft'). " +
    "autopilot.graph.node.draft labels the autopilot DRAFTING step and its " +
    "produced draft translations (the pipeline-graph caption and the review " +
    "inspector's card title) — the activity of machine-drafting text, a " +
    "different sense languages split from 'unfinished document'.",
  "terminology.livingMemory.section.brief.statusComplete":
    "Hint on the Living Memory index saying every brief field is filled in — " +
    "'complete' as document completeness. autopilot.status.complete is the " +
    "terminal value of the run-status enum — a PROCESS that finished; " +
    "'filled-in' vs 'finished' are commonly different words outside English.",
  "terminology.livingMemory.prompt.defaultBadge":
    "Badge on the prediction-prompt block stating the prompt is the unmodified " +
    "built-in one — 'default' as a setting state, paired with the sibling " +
    "Custom badge. org.projectOverview.laneDefaultFallback names the unnamed " +
    "target LANE shown when a project has no named lanes — a placeholder noun " +
    "('the default one'), a different grammatical role.",
  "terminology.livingMemory.section.examples.title":
    "Index-row title for the validated-example-pairs section of Living Memory " +
    "— a plain plural noun heading. agent.run.tool.examples is the display " +
    "name of the agent's retrieve-examples TOOL call in the run log — an " +
    "operation name that several languages render verbal ('fetch examples').",
}
