# Day One · design

Where the designs live, what we chose, and the rules they follow. The design brief for every screen is [`features.md`](features.md).

## Where the designs are

| What | Link | Notes |
| --- | --- | --- |
| Design canvas (live, interactive) | <https://claude.ai/artifact/T59ApSFxqJmzNtGQSqF6Vu> | Landing page, phone hero, discharge summary screens, alternative concepts, brand board. Private until shared from its Share menu. |
| Figma file | <https://www.figma.com/design/gRugWJ5KP4UfoRbzYAMcIP> | Pages: Design system (variables, text styles, components), Discharge summary, Landing page, Brand. |
| Landing page you can open locally | [`design/landing-page.html`](../design/landing-page.html) | Double-click it. "Scan my papers" opens the app at <http://localhost:3100> (`npm run sample`). |
| Canvas source | [`design/canvas/`](../design/canvas/) | The `.dc.html` artboards, for reference. They need the canvas runtime to render. |
| Team logo | [`design/brand/day-zero-logo-dark.svg`](../design/brand/day-zero-logo-dark.svg) | Day Zero wordmark. |

## Naming

- **Day Zero** is the team. **Day One** is the product: the app for a patient's first day back home.
- Pitch line: *"Day Zero builds Day One, the app for a patient's first day back home."*
- The Day One mark reuses the Day Zero ring and orange dot, with the dot at 12 o'clock (the start of a new day).

## Chosen direction: Concept A, simplified

The landing page is for patients, so it stays short:

1. **Hero:** "Understand your hospital papers." One **Scan my papers** button, an "See an example" link, and one before/after (papers → plain words) with a **Listen** button.
2. **How it works:** Take a photo → We check it → Read or listen.
3. **What you get:** when to take each medicine, when to call 911, where each line came from.
4. **Is it safe?:** three plain promises.
5. **Ready when you get home:** the same Scan button.

Kept off the patient page on purpose: the agent conversation, the 81% statistic and the partner list. They belong in the demo video or a separate "How we built it" page for judges.

Quality of life: a **Larger text** toggle, a real read-aloud (browser speech), a gentle fade-in, and no animation when the device asks for reduced motion.

## Colour: "Calm & Critical"

| Role | Colour |
| --- | --- |
| Page background | `#F8F9FA` (cards `#FFFFFF`) |
| Headings / body text | `#0F172A` / `#1E293B` |
| Muted text | `#475569` |
| Borders | `#E2E8F0`, `#F1F5F9` |
| Medicines, changes, actions | Trust Blue `#2563EB` (text on white: `#1D4ED8`) |
| Red flags and stopped medicines only | Crimson `#DC2626` (small text: `#B91C1C`) |
| Done / passed checks | Green `#16A34A` (text: `#15803D`) |
| Brand dot | `#FF4A1C` |

All text meets 4.5:1 contrast. Colour only carries meaning, never decoration.

## Type

- Product screens: **Inter** (Bold headings, Medium subheads, Regular body at 16/24).
- Landing page: **Bricolage Grotesque** for headlines, **Atkinson Hyperlegible** for body (made by the Braille Institute for low vision).

## Content rules

- Every sentence on a patient screen must come from the pipeline's real output; no invented advice, times or reasons.
- Never drop a warning sign from a "call 911" list.
- Show a dose conflict (e.g. carvedilol 12.5 mg on the papers vs 25 mg in the record) as a red "check with your care team", never resolve it.

## Next

- Done: `public/` is now the full app in this design. Run `npm run sample` and open <http://localhost:3100>.
- Photos: the Photo tab works once Nightshift has a vision model; until then the page says to paste the text.
