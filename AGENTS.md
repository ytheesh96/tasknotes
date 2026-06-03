# TaskNotes - Agent Development Guide

This is an Obsidian plugin. The plugin ID is `tasknotes`.

## Build & Test

```bash
# Build the plugin and copy files to the repo e2e vault
npm run build:test

# Build, copy to the running Obsidian vault, reload, and check errors
npm run verify:obsidian
```

Always run both commands after making plugin source changes. Obsidian must be running for the live-vault CLI checks to work.

The live-vault scripts default to the running vault named `Obsidian` and the plugin directory `~/Documents/Obsidian/.obsidian/plugins/tasknotes`. Override with `TASKNOTES_OBSIDIAN_VAULT_NAME` and `TASKNOTES_OBSIDIAN_PLUGIN_PATH` when testing another vault. Do not use `vault=test` unless that vault alias is actually registered and open.

## Useful Obsidian CLI Commands

```bash
# Check for JavaScript errors after reload
npm run errors:obsidian

# View console output
obsidian vault=Obsidian dev:console

# Run JavaScript in the Obsidian context
obsidian vault=Obsidian eval code="app.vault.getFiles().length"

# Take a screenshot to verify UI changes
obsidian vault=Obsidian dev:screenshot path=screenshot.png

# Open developer tools
obsidian vault=Obsidian devtools
```

## Other Build Commands

```bash
npm test              # Run unit tests (Jest)
npm run lint          # Lint source files
npm run typecheck     # TypeScript type checking only
npm run build         # Production build (without copying to vault)
```

Ensure all code changes pass linting checks. Do not weaken linting rules in order to get changes to pass. 

---

When you make changes, update docs/releases/unreleased.md. If your changes are related to a GitHub issue or PR, include acknowledgement of the individual who opened the issue or submitted the PR. Do not update unreleased.md for the addition of tests; unreleased.md is user-facing. 

You may update `.ops/` files locally as you work on items, but do not commit `.ops/` files. `.ops/` is local-only working state.

## Investigating issues

When investigating issues, you should try your best to reproduce them first. You can do a lot with the obsidian cli tool. If you have a theory about what is causing an issue, test that theory.

Not all reported issues will require changes to the code, and not all feature requests need to be implemented; Bases are very powerful, but can be difficult to navigate. If something is not working, or is being asked for, figure out if it is--or can be--achieved through Bases first.

## Prepare for a release. 

When asked to prepare for a release: 

1. Run through the @I18N_GUIDE.md and make sure translations are up-to-date (and in their target language--not English placeholders). 
2. Make sure ALL `npm run test` tests are passing. 
3. Make sure there are no linting errors.
4. Make sure all items in @docs/releases/unreleased.md thank the correct issue/pr opener (double check), as well as those who have commented on the issue/pr. Make sure the copy is appropriate--it is user facing so it should not be overly technical. Make sure it is free from anything that resembles marketing copy. do not thank callumalpass 
5. Move the body of unreleased.md to <VERSION NUMBER>.md, following the pattern of previous released. Leave the comments that explain unreleased.md inside unreleased.md.
6. Update @manifest.json and @package.json. 
7. Commit changes as \"release <VERSION NUMBER>\" (you can choose the version number unless it is specified). 
8. Tag the commit. (Just version number, no 'v' prefix. 
