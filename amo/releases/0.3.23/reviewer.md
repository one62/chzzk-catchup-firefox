Version 0.3.23 is a version-only update to the extension package compared with 0.3.22. The manifest version number changed; the extension JavaScript, popup files, icons, permissions, and host permissions are unchanged.

The repository also adds GitHub Actions release automation and development tooling. Those files are excluded from the extension package. The package contains only manifest.json, src/, popup/, and icons/.

Validation: 211 automated tests passed, repository manifest/script checks passed, and web-ext lint reported zero errors and two compatibility warnings about the data_collection_permissions manifest key being newer than the declared minimum Firefox version. These automated checks do not establish live CHZZK playback or end-to-end clip creation behavior. No new manual Firefox/CHZZK runtime verification was performed for this version.
