# v0.1.0 — Safari development preview

First private release of the Safari port of ChatGPT Chrome extension
1.26.1005.11759. This is an unofficial, Apple Development-signed Universal app
for **macOS 14 or later**, supporting Apple Silicon and Intel Macs. It is not
notarized. The app's bundle version remains **1.26.1005 (11759)**.

## Download and setup

Download `ChatGPT-for-Safari-v0.1.0-macOS-universal.zip`, extract it, and open
**ChatGPT for Safari.app**. Enable the extension in Safari Settings and grant
website access. Allow Accessibility access for Work's mouse and keyboard
controls. Keep only one active copy of the extension; an existing development
installation should continue using its canonical app. macOS may require manual
approval to open this development-signed build.

## Available now

- Original inline ChatGPT sidebar, resizable layout, persistent conversation,
  selected-text attachments, and multi-tab context.
- Original Work agent operating existing, signed-in Safari pages: reading,
  typing, clicking, scrolling, selection controls, screenshots, and rich
  clipboard operations.
- New tabs and windows, tab reordering, native Safari Tab Groups, history search,
  and bookmark reading, creation, editing, and movement.
- Known native dialogs and visible file inputs, including multiple-file upload.
- Policy-approved file downloads, conditional delayed and detached-button
  downloads, website-generated temporary downloads, and cross-site redirects.
- Google Workspace export routes, with Google Sheets CSV verified, plus verified
  YouTube caption export and page-asset saving.
- Existing ChatGPT/Codex desktop connection and separate optional desktop controls.

## Accepted evidence

The shipped app reuses the accepted signed Universal build. All 60 affected
download checks passed. Real original-Work sidebar acceptance includes detached
and delayed downloads, immediate-revoke temporary files, a destination-tab
cross-site download, and a 3,145,728-byte download completed in 22.1 seconds.
Closing the sidebar during a separate live transfer cancelled writing, removed
the incomplete file, and did not repeat the request. See the README's
[installed acceptance](README.md#installed-acceptance) for the complete record.

## Important limits

- Some delayed website downloads cannot be reliably attributed to the original
  click and remain unsupported. Temporary-file support is conditional.
- Some cross-site downloads require an already-open, authorized destination-site
  tab. Arbitrary destinations are not universally supported.
- Downloads are limited to **32 MiB** and **30 seconds of active transfer**.
- Uploads require a visible file input. Dialog handling requires known exact
  dialog content. Neither route supports every website's custom controls.
- Bookmark deletion, website prompt prefill, and visible system notifications
  have not completed installed end-to-end acceptance.
- Chrome-style group colors/collapse/reordering, Top Sites, recently closed
  items, and website-provided AI tools are unavailable.
