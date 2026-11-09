# Streaming downloads version checkpoint

`version-manifest.json` ties the existing sibling repositories to exact commits.
Each repository also has the local tag `streaming-downloads-1.0`.
The Chromium tag preserves the implementation; the extension and assignment
materials have their own repositories without moving their folders.
The depot_tools tag records its unchanged tool revision.

To inspect a saved project without changing files, run `git show streaming-downloads-1.0`
in that repository. To restore it, first save any current work, then run
`git switch --detach streaming-downloads-1.0` in each listed repository.
This manifest repository is tagged with the same version.

The tag saves source code, not a built browser. Chromium dependencies must be
synced and the browser rebuilt when restoring a different source revision.
Excluded local files and the development launch command are listed in the manifest.
The analysis and patch documents are saved as they currently exist, not regenerated.

All commits and tags are local; nothing has been uploaded.
