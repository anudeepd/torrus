# Changelog

## [0.2.51] - 2026-09-22

### Security
- Private-host guard: `TORRUS_ALLOW_PRIVATE_HOSTS` now also covers RFC 6598 shared address space (`100.64.0.0/10`), which overlay networks such as Tailscale use.
- **SSH host keys are now verified.** Connections load the system
  `~/.ssh/known_hosts` plus a Torrus-managed store and refuse a host whose key
  has changed, printing both fingerprints. An unknown host is recorded on first
  use (`TORRUS_SSH_HOST_KEY_POLICY=accept-new`, the default) or refused outright
  with `strict`. Previously every key was accepted and nothing was remembered.
- **Private, loopback, link-local and cloud-metadata targets are refused by
  default**, by name as well as by literal address, in both LDAP and non-LDAP
  deployments. Set `TORRUS_ALLOW_PRIVATE_HOSTS=true` to allow them; the older
  `TORRUS_ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP` is honoured as a deprecated alias.
- **The server decides what counts as sensitive input.** Prompt detection now
  reads the output stream server-side and can only be *added to* by the client
  hint, so a modified client can no longer keep a secret out of the redaction
  path.
- **Bulk archives are spooled to disk and capped.** Each member is streamed in
  bounded reads instead of the whole file being materialised, member names are
  normalised so a hostile filename cannot escape the extraction directory, and a
  selection larger than `TORRUS_BULK_ZIP_MAX_BYTES` (2 GiB) is refused before
  the archive starts.
- `sftp:delete` accepts at most 500 paths per request, matching `sftp:mkdirs`.
- The response CSP gained `frame-ancestors 'none'`, `form-action 'self'`,
  `base-uri 'self'` and `object-src 'none'`, and `connect-src` is `'self'`
  instead of any host on `ws:`/`wss:`. Without ldapgate, responses now also
  carry `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy`.

### Added

- Continuous integration: `test.yml` runs ruff and pytest on 3.10-3.12 with the
  `ldap` extra, the frontend suite, a production build whose bundle must match
  what is committed, a wheel smoke test and a tag-versus-version check;
  `release.yml` gates a tag, rebuilds, diffs the bundle and publishes through
  PyPI OIDC.
- `make lint`, `make test`, `make check` and `make verify-assets`, plus the
  `[tool.ruff]` configuration the declared `ruff` dependency never had. The
  first run found 51 issues; they were fixed rather than suppressed.
- A web app manifest and an Apple touch icon, so the terminal installs to a
  home screen. Both are served with their real content types and added to the
  ldapgate static allowlist.
- Code splitting: the terminal, the SFTP browser and the admin console load on
  demand instead of with the shell.
- One `Dialog` primitive now backs all nine dialogs - overlay, scrim, focus
  trap, Escape through a shared dismiss stack, transitions - replacing eight
  hand-rolled shells.
- Keyboard access where only the mouse worked: `F6` moves focus out of the
  terminal to the active tab, `Alt+Left`/`Alt+Right` and two context-menu items
  reorder tabs, the split divider resizes with the arrow keys, and the admin
  console's compact view switcher is a real tablist.
- Behavioural tests for the settings dialog, the command palette and the layout
  picker, an audit-CLI suite covering the escaping contract, and one
  token-parity file replacing three that asserted source text.

### Changed

- Every HTTP error uses one envelope, `{"ok": false, "code", "message"}`
  (previously the upload routes answered `{"detail": ...}`).
- Responses are gzipped above 1 kB: the shell was shipping about 1.2 MB
  uncompressed.
- The Socket.IO client starts on long polling and upgrades to WebSocket when the
  proxy allows it, instead of pinning polling.
- An idle SSH session no longer re-submits to the I/O pool every 100 ms, and a
  new `TORRUS_MAX_SSH_SESSIONS` ceiling (default 128) refuses new sessions
  rather than letting every terminal stall when the pool runs dry.
- An interrupted download no longer holds a tab lock across chunks: each SFTP
  request takes it, so a concurrent listing cannot interleave with a read.

### Fixed

- Contrast, measured on the SFTP surface: the faint tier failed 16 of 29 text
  nodes, the connect button measured 3.82:1 at rest and 2.54:1 on hover, and
  placeholders 2.66:1. All three now pass (0 of 33, 4.82:1 and 4.77:1, 6.96:1).
- Twelve primary controls were under 24x24; only the off-screen skip link
  remains below it, by design.
- Landmarks and headings: `main`, `nav`, an `h1` and a skip link; the tab strip
  is a real tablist with `aria-controls`, roving `tabindex` and a `tabpanel`,
  and the context menus have menu semantics instead of button roles.
- A refused connection now announces itself: `role="alert"` with `aria-invalid`
  and `aria-describedby` on every field, in the connect form and on the login
  card, which also gained a heading, a `main` landmark, `theme-color` and
  `viewport-fit=cover`.
- Duplicate tabs are numbered - `root@host (1)`, `(2)` - instead of carrying
  three identical labels.
- Bulk download held a whole archive member between drains and peaked at
  1,268.8 MB of RSS for a 400 MB archive. Draining per block, with the spool
  reporting itself non-seekable so `zipfile` writes data descriptors instead of
  seeking back to patch member headers, brings the peak to 84.7 MB, flat from
  64 MB of payload onward.
- The known-hosts store was parsed once per process, so removing a stale entry -
  the remedy the mismatch message itself prescribes - had no effect until a
  restart. It is re-read on every connect.
- The connect throttle keyed on the client address alone, which behind a
  reverse proxy with no `trusted_proxies` entry gives every user one shared
  bucket of ten attempts a minute. It is now ten per socket plus sixty per
  address.
- The split divider was drag-only: it is now a focusable `separator` with a
  label, orientation, values and arrow-key resize.
- The admin console's compact view switcher claimed `role="tab"` with no
  tabpanel, no `aria-controls` and no arrow keys, and its controls had no focus
  ring.
- Maps that grew for the life of the process now prune: issued CSRF tokens, SSH
  generation counters, per-tab SFTP locks and policy-store backups.
- Locks are no longer held across a yield in either download stream, upload
  eviction aborts its victims after releasing the store lock, and `clone`
  closes the replaced session outside the manager lock.
- `test_upload_engine_parity.py` could not detect the drift it guarded; it now
  compares the vendored copies byte for byte. The sdist ships
  `tests/conftest.py`.


## [0.2.50] - 2026-09-20

### Changed

- Share one login card with ldapgate, lagun and xwing: the same two animations (`login-card-in` 340ms, `login-error-up` 180ms), an always-present error slot whose message carries `role="alert"` with both fields linked to it by `aria-describedby`, one `:root` block instead of colours scattered through the stylesheet, and the same username rule (restore the saved name only after a failed attempt). The card now differs from the other three only by colours, name, brand mark, title and favicon.
- Take the darker green `#047857` for the submit fill and lighten to `#168163` on hover, so the white label keeps 4.82:1 while the hover still brightens the way the rest of the app does. The previous pair measured 3.77:1 at rest and 2.54:1 on hover against a white label; the app's own `brand-500` (`#10b981`) cannot carry white text at all.
- Move placeholders and secondary copy to `#86909d`: the old `#475569` measured 1.93:1 on the input surface and 2.66:1 on the page.
- Require ldapgate 0.1.28 in the `ldap` extra.

## [0.2.49] - 2026-09-19

### Added

- Re-read the open SFTP folder every 15 seconds, so a file another session creates, deletes or renames shows up on its own. The listing is replaced without a loading state or a cleared selection, and the refresh stands down while a dialog or menu is open, a transfer is queued or running, the pane is off screen, or the window is hidden; returning to the tab or the window refreshes straight away.

### Fixed

- Reloading the page dropped an SFTP tab back to the home directory, because the folder only lived in memory. A tab now remembers the folder it was showing and reopens there, falling back to the home directory when that folder is gone.
- Closing a dialog cut out in a single frame in two places: the "Close tab?" / "Close all tabs?" confirmation was never wrapped in `AnimatePresence`, and the Save Session dialog had no motion at all, while every other dialog faded. The SFTP folder listing and its "Loading folder…" strip were unmounted the same way, so neither played the transition their props described.

## [0.2.48] - 2026-09-16

### Changed

- Send upload bytes down an SSH exec channel (`cat`) instead of as SFTP write requests. SFTP caps a write at 32 KiB and answers each one, which measured ~117 MB/s through the upload sink and ~174 MB/s for the raw protocol on a local link; the same bytes measured ~254 MB/s through the channel on that link. The staging file, the range accounting and the atomic rename are unchanged.
- Upload 32 MB windows instead of 8 MB ones, and run four of them per file instead of one. Every window is a request, so an upload used to wait for the remote write plus a full round trip before it could send the next bytes; several windows in flight keep the remote host busy while the request socket is still filling. Tunable with `TORRUS_UPLOAD_CHUNK_BYTES` and `TORRUS_UPLOAD_CONCURRENCY`.

### Fixed

- Uploading a zero-byte file was refused with "Upload session has no data". The chunked engine now opens the destination itself when a file has no bytes, so the empty file lands like any other upload.
- Overwriting a file that already exists on the remote host failed at the final rename with "Failure". The staging file is now renamed over the destination when the server supports the posix-rename extension, and the old name is cleared first when it does not.
- An upload the remote host refuses partway through (a destination it cannot write, a full disk) reported "SSH connection lost. Reconnect to continue." instead of what the host actually said. Uploads now surface the remote writer's own message.

## [0.2.47] - 2026-09-15

### Changed

- Route SFTP uploads through the chunked upload engine shared with x-wing: the server tracks committed byte ranges, so a stalled or interrupted upload resumes from the bytes it already holds instead of re-sending a whole chunk.
- Keep one SFTP channel and one remote staging file per upload session, coalesce writes before they reach the transport, and publish with a single rename so the destination never shows a partial file.
- Drop the per-chunk 30-second client timeout that killed slow or DLP-inspected uploads; a request is abandoned only after a period with no byte movement.
- Chunk size no longer grows with file size: large files transfer in fixed 8 MB windows that the server may tune.
- Remove the Socket.IO inline upload path (`sftp:upload`), superseded by the chunked engine for every file size.

### Added

- Upload a whole folder by dragging it onto the file browser: the drop is walked locally, the destination folders are created on the remote host in one request (`sftp:mkdirs`), and each file uploads into its own folder. Re-uploading into an existing folder is a no-op for the folders that are already there.

### Fixed

- Show "waiting for server" while the server writes to the remote host instead of an apparently frozen upload.
- Explain an unreadable drag-drop instead of silently creating a zero-byte file named after the dropped folder.
- Keep the zip progress overlay on screen while an archive is building: a second "Download N as zip" request is ignored instead of clearing the overlay when the first request finishes.

## [0.2.45] - 2026-09-01

### Added

- Group consecutive command lines from the same session into collapsible blocks in the Admin Console's Submitted input view; stored audit rows remain one row per line.
- Add Type, Host, and Until filters to the Submitted input panel and activity API, with server-side kind routing across terminal and SFTP event tables and a live result count.
- Broaden activity free-text search to every audited column (command text, path, detail, user, host, SSH user, session, tab) while sensitive rows stay redacted.
- Add drag-to-reorder tabs (lagun parity), persisted with tab state and safe in split mode.
- Replace the scrollable-table chrome with a quiet icon toggle across all admin tables.

### Changed

- Rebuild bundled frontend assets for the release.

## [0.2.43] - 2026-08-24

### Fixed

- Show the command-palette toolbar button only in the compact (mobile) layout so desktop no longer displays the duplicate icon.
- Add regression coverage for the command palette button's compact-only visibility.
- Rebuild bundled frontend assets for the release.

## [0.2.36] - 2026-08-13

### Fixed

- Claim Ctrl+L for terminal clear and SFTP path editing only on macOS so Windows and Linux keep the browser's address-bar shortcut.
- Remove browser-reserved Ctrl/⌘+T, Ctrl/⌘+W, Ctrl+Tab, and Ctrl/⌘+K shortcuts from Torrus, and add a visible command-palette button in the toolbar.
- Add regression coverage for platform-safe shortcut handling across macOS, Windows, and Linux user agents.
- Rebuild bundled frontend assets for the release.

## [0.2.32] - 2026-08-02

### Fixed

- Auto-dismiss Admin Console success notices after five seconds.
- Make Enter submit Submitted input filters reliably from keyboard.
- Replace semicolon-separated admin and SFTP feedback with sentence-based copy.
- Rebuild bundled frontend assets for the release.

## [0.2.31] - 2026-08-02

### Added

- Support partial, case-insensitive username and command search in the Admin Console's Submitted input view, including Enter-key submission.

### Fixed

- Apply LDAP user disable and re-enable changes immediately without a Torrus restart.
- Animate terminal-to-admin navigation without skipped-transition errors or page flashes.


## [0.2.30] - 2026-08-02

### Added

- Apply permission and ownership changes to multiple selected SFTP entries from the file context menu.
- Add admin-console user allowlist entries without requiring a Torrus restart.

### Fixed

- Report non-empty remote directories with an actionable SFTP deletion error instead of the server's opaque `Failure` response.
- Keep current SFTP errors visible ahead of stale success notices.
- Label folder creation, rename, upload, download, listing, permission, ownership, and account-loading failures with operation context while preserving server details.
- Close disconnected SSH tabs without showing the active-session confirmation.
- Refresh the current SFTP directory after successful uploads, retried uploads, permission changes, and ownership changes.
- Remove cross-document view transitions from terminal/admin navigation, eliminating skipped-transition errors and page flashes.
- Restore SSH connection state transitions so retries clear stale authentication errors and successful connections leave the form.
- Animate terminal workspace entry when returning from the admin console.
- Preserve browser text selection while confirmation modals remain open.
- Improve retention cleanup copy and make irreversible deletion scope explicit.

### Changed

- Align SFTP dialog typography, field spacing, sentence case, path readability, and compact-viewport feedback controls with the rest of the app.
- Animate SFTP feedback rails, drag-and-drop overlays, action menus, disconnect states, and dialogs with the shared reduced-motion-aware motion system.
- Keep rename editor keystrokes isolated from file-browser shortcuts while preserving menu and dialog focus, arrow-key, and Escape behavior.
- Stream large SFTP downloads directly to the browser with 4 MB server chunks and a declared content length, avoiding full-file browser buffering.

## [0.2.10] - 2026-07-19

### Added

- Add a shared, reduced-motion-aware animation system for workspace surfaces, tabs, dialogs, saved sessions, connection states, SFTP navigation, and transfers.
- Preserve terminal ownership while adding continuity cues around normal and split layouts.
- Add a compact command palette for searchable tab switching and workspace actions, available from the header or with Ctrl/Cmd+K.
- Add a Lagun-style compact sessions drawer with an animated overlay, scrim, Escape dismissal, and full-width workspace when closed.

### Changed

- Keep the current SFTP directory visible and inert while newer directory contents load.
- Ignore stale SFTP directory responses and coalesce repeated refreshes of the same pending path.
- Key completed-transfer retention timers by transfer ID so unrelated progress cannot postpone removal.
- Improve SFTP breadcrumb separator sizing.
- Adapt the tab bar for compact viewports with a dedicated two-row header, stable command placement, touch-accessible tabs, and overflow-free contextual actions.
- Move compact split controls into the command palette while preserving visible desktop split actions.
- Make SSH connection forms respond to their pane width so fields remain usable in compact split layouts.
- Center and constrain compact empty-state copy, and smooth SSH connecting, disconnecting, split-layout, broadcast, settings, and confirmation transitions.

## [0.2.2] - 2026-07-13

### Added

- Add direct SFTP path navigation, visible SSH username, and robust connection-loss recovery.

### Changed

- Return SFTP open and list failures through their corresponding result events for inline navigation feedback.

## [0.2.1] - 2026-07-13

### Added

- Document SFTP file browser feature in README.

## [0.2.0] - 2026-07-13

### Added

- Open an SFTP file browser from any connected terminal tab and browse remote directories over the existing SSH session.
- Upload, download, rename, delete, and create remote folders from a terminal-dense file browser UI with keyboard navigation, drag-and-drop upload, selection toolbar, and transfer queue.
- Stream uploads larger than 25 MB through a dedicated HTTP endpoint while keeping small uploads on Socket.IO.
- Package the rebuilt frontend assets for the SFTP browser.

### Changed

- Track tab type in persisted terminal state so terminal and SFTP tabs can render through the same tab bar and split-pane layout.
