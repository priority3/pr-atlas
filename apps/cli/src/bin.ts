#!/usr/bin/env node
// Reason: the bin entry lives in its own file so it can call main() unconditionally.
//
// It used to live at the bottom of main.ts behind a guard that compared
// `process.argv[1]` with `import.meta.url` to answer "am I the entry module?".
// That guard is wrong for a published CLI: npm installs the bin as a symlink at
// node_modules/.bin/atlas, so argv[1] is the symlink path while import.meta.url
// is the resolved real path. The two never match, main() never ran, and `atlas`
// exited 0 with no output at all. Running dist/main.js directly did match, which
// is why the bug survived local testing — it only appears through the symlink.
//
// A dedicated entry file removes the question instead of answering it: this file
// exists only to be executed, and main.ts stays side-effect free so tests can
// import it.
import { main } from './main.js'

void main()
