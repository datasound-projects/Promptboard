# STE method and its limits

This app rewrites a request for a coding agent. Its English writing target draws on ASD-STE100 principles. It is an independent writing aid, not a certified STE checker.

## What the rewrite must preserve

- The goal, requirements, priorities, restrictions, and exclusions.
- Exact code, commands, paths, identifiers, URLs, numbers, units, and quoted text.
- Conditions, dependencies, action order, and actions that must occur together.
- Uncertainty: a missing project fact must not become an invented fact.

The model receives a rewrite contract followed by source material marked as data. It must produce a prompt, not execute the task. This separation reduces ambiguity; it is not a complete defense against prompt injection. The CLI restrictions are described in [cli-adapters.md](cli-adapters.md).

Detail settings change the amount of explanation. They must not remove requirements. Enabled planning and checking options add relevant guidance, not new product scope. The model must label necessary assumptions and keep unresolved conflicts visible.

## The English writing target

The official website currently identifies **Issue 9, dated 15 January 2025**. These selected limits were checked against that edition:

| Reference | Meaning for this app's writing target |
| --- | --- |
| Rule 5.1 | Procedural sentences have a 20-word ceiling. |
| Rule 5.2 | Separate instructions, except when actions must happen simultaneously. |
| Rule 6.3 | Descriptive sentences have a 25-word ceiling. |
| Rules 6.5 and 6.6 | A paragraph covers one topic and has at most six sentences. |

These limits are only a small part of the standard. Section 8 has special counting rules for items such as quoted text, parentheses, measurement values, and names. Splitting on spaces does not reproduce those rules.

The app also asks for complete grammar, active instructions, explicit references, and consistent terms. Exact technical text takes priority over changing that text to satisfy a prose check.

German and Polish output uses clear technical language. It is not English STE and must not be described as STE compliant.

## What the checks mean

Read the result's check report and the [verification notes](verification.md) for the checks that ran. Keep these distinctions clear:

| Check type | What a successful result establishes | What it does not establish |
| --- | --- | --- |
| Exact-text comparison | The extracted text being compared is present unchanged. | Every technical item was extracted, or its meaning and context stayed correct. |
| Prose lint | The implemented patterns found no remaining warning. | Complete grammar, dictionary, or STE compliance. |
| Model review | A model assessed the draft against stated criteria. | Independent proof that the draft is correct. |
| Human review | A person assessed the prompt for its intended task. | A universal guarantee for other tasks or future model runs. |

A result with no detected issue is still a draft to review. The app does not calculate a STE compliance percentage. Its English sentence classifier and counts are estimates. Markdown, abbreviations, fragments, and quoted material can affect them. A model can also overlook omissions, changed negations, or added scope.

The app does not include the official dictionary or a complete linguistic parser. The optional term list provides context; it is not a list of officially approved words. Dictionary meanings, parts of speech, and project terminology require informed review.

## What the supplied white paper supports

The **June 2026 STEMG and STEMG Artificial Intelligence Task Team white paper** supports human oversight, explicit limits, traceability, and evaluation of AI-assisted work. It describes possible benefits and risks. It contains no controlled experiment or coding-agent benchmark that proves this app improves accuracy, saves tokens, or produces better code.

The design consequence is practical: keep the source, expose findings, test known failures, and let the user review the result. Model self-review alone cannot establish reliability. See [verification.md](verification.md) for the tested behavior and remaining limits.

## Sources and maintenance

Review date: **28 September 2026**. This is a dated source review. The app does not download or update its writing rules silently.

- [Official ASD-STE100 overview](https://www.asd-ste100.org/about_STE.html): current edition, dictionary, and technical terminology.
- [Official Issue 9 PDF](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf): authoritative reference; sections 5, 6, and 8 and the copyright page were reviewed for the points above.
- [STEMG white paper and official downloads](https://www.asd-ste100.org/STE_downloads.html): the supplied three-page June 2026 paper was read in full.
- [STEMG guidance on tools](https://asd-ste100.org/STEsoftware.html): limitations of automated checking, user responsibility, and the non-endorsement policy.

ASD owns the standard and its trademark. Free access does not make the standard an open-source dictionary. Its copyright page sets permission terms and special usage rights. This repository does not redistribute the standard, dictionary, white paper, or ASD logo. The software's MIT license does not apply to those materials.

ASD and STEMG do not endorse or certify this app. Before changing the method, review the primary sources again and test representative requests. A prompt-quality claim needs measured results on the tasks and models for which that claim is made.
