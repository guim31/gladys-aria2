# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-21

### Added

- One aria2 device: download and upload speeds, active, waiting, completed
  and failed downloads, the current downloads with their percentage, the
  download speed limit and whether aria2 answers.
- Two switches: **Pause all** (pause and resume every download) and **Slow
  down** (the download limit chosen in the configuration, or none).
- Scene triggers: **Download completed** (name, size, folder), **Download
  failed** (name, error message and code), **Nothing left to download**.
  Instant, through the WebSocket notifications of aria2.
- Scene actions: **Add a download link** (http, https, ftp, sftp, magnet,
  .torrent or .metalink, optional folder), **Pause every download**, **Resume
  every download**, **Set the download speed limit**.
- The **aria2 downloads** dashboard widget: speeds, downloads in progress,
  counters, Pause all, Resume all and Slow down buttons.
- **Test the connection**, and documentation in English, French, German and
  Spanish.

[Unreleased]: https://github.com/guim31/gladys-aria2/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-aria2/releases/tag/v1.0.0
