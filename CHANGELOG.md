# Changelog

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
