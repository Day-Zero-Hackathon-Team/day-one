# Design files

- `canvas/`: source of the design canvas artboards (`.dc.html`) and its layout (`canvas.json`). Open the live canvas to view them: https://claude.ai/artifact/T59ApSFxqJmzNtGQSqF6Vu. `Logo.dc.html` loads the Day Zero logo from the canvas's own asset store, so it only renders there.
- `landing-page.html`: standalone copy of the landing page. Double-click to open it in any browser; no install needed. Its "Scan my papers" buttons go to the app at http://localhost:3100, so start the app first with `npm run sample`.
- `brand/`: the Day Zero team logo.

See [`docs/design.md`](../docs/design.md) for the design decisions and the Figma link.
