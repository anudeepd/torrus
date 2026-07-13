# Changelog

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
