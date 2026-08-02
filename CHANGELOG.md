# Changelog

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
