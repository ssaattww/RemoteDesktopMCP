# Issue 70 Todo UI preview

Generate a standalone HTML preview from the real user console route:

```sh
npm run preview:issue70
```

Open `artifacts/issue70-todo-preview.html` in a browser. Use the browser's responsive device mode at **320 CSS px**, then check a desktop width. No product server, user login, API connection, or test data setup is needed while viewing the file.

The output uses the product's server-rendered HTML, inline CSS, and exact client bundle. A small preview-only bridge replaces `fetch` and `EventSource` with local sample responses so Todo refresh, add, text/status update, and the enforcement toggle can be exercised without network access. Any unrecognized fetch path throws an error in the browser console. The bridge does not run in the product or alter its API/authentication behavior.

The generated sample includes in-progress, completed, and not-started Todos; a long multiline item; an initially collapsed add form; and enforcement disabled so its toggle is visible. The bridge provides versioned in-memory Todo updates and never persists changes. The generated HTML contains only synthetic data and replaces the temporary login CSRF value with a non-secret preview token.

The regeneration command starts the existing fixture app on an ephemeral loopback port, signs into it using its synthetic test account, captures the actual detail-route HTML, injects the offline bridge, writes the file, and shuts down the app and temporary data directory. To run the existing HTTP integration fixture interactively for tests, use `node --import tsx scripts/issue70-ui-fixture.ts --serve`.
