# Mascot provenance

This original mascot was created for Promptboard (formerly AI Prompt Engineer) based on ASD-STE100 Simplified Technical English (STE) on 2026-09-28 with the built-in OpenAI image generation tool. It was generated without reference images.

Asset: `public/nerd.png` (no longer shipped; this record is kept for provenance)

The generated PNG is used unchanged. Its alpha channel is preserved. The request specifies an original character, with no known character or public-figure likeness. This record describes the generation process; it is not a trademark or originality guarantee.

## Generation prompt

```text
Use case: logo-brand
Asset type: original mascot mark for an open-source AI prompt engineering application, optimized for a 96px UI icon.
Primary request: a black-and-white cartoon nerd who looks ultra epic, gloriously ugly and nerdy, mischievous and confident.
Subject: a single original human nerd head and a tiny hint of shirt collar, huge thick taped glasses, uneven crooked buck teeth, wildly spiky disheveled hair, asymmetrical ears, expressive eyebrows and a confident mischievous grin. Funny and instantly memorable.
Style/medium: premium underground-comic ink mascot logo, bold clean black shapes and strong white areas, graphic sticker silhouette, chunky high-contrast outlines, deliberate simplified details, crisp professional mark with punk character.
Composition/framing: square image, centered head, completely visible hair and ears, tight but comfortable framing with a little transparent margin. Strong compact silhouette readable at 96px.
Color palette: only pure black and white; real transparent background with alpha; white facial regions must stay solid white.
Constraints: no lettering, no text, no watermark, no background, no objects, no frame, no gray shading, no gradients, no likeness of a known character or public figure.
```

## GitHub logo

`docs/readme-logo.png` is the original PNG supplied by the project owner, displayed at 960 px wide in the GitHub README. The app does not use it. `docs/logo.png` is the 480 px version used by the social preview renderer.

## GitHub social preview

`docs/social-preview.png` uses the same supplied mascot with a minimal dark overview of Origin, Compose, Kanban and Base. The 1280×640 card is rendered with `node scripts/create-social-preview.mjs`; no new image generation is needed. Upload this PNG in the repository's General settings under Social preview after regenerating it.
