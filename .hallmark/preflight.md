# Installer UI

- Existing font stack: system UI with Persian fallbacks (`public/style.css:33`). Retained for offline availability; no font CDN on a credential screen.
- Existing palette: slate backgrounds and blue accent (`public/style.css:1`). Retained, with a darker blue button for readable small text.
- Framework: plain HTML, CSS and JavaScript. No UI dependencies added.
- Motion: no animation libraries. Only button press feedback; reduced motion removes movement.
- Structure: Narrative Workflow, right-hand step rail, inline footer. Functional three-stage wizard rather than a marketing page.
- Responsive checks: 320, 375, 414, 768 and 1280 CSS pixels; no horizontal overflow. Connection, configuration, review, progress, error, retry and completion implemented.
- Scope: additive `installer/` UI. Existing messenger routes and interface preserved.
