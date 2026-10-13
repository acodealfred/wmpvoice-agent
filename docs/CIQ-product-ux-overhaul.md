# CIQ Product & UX Overhaul

## Purpose

This document records the agreed product direction for CIQ, a private wellbeing self-reflection tool that combines guided questions, camera-derived session markers, and voice sentiment to help a person choose an appropriate recovery resource.

The design goal is simple: the experience should feel calm, personal, safe, and useful—not technical, diagnostic, or employer-led.

## Confirmed product model

- CIQ is for anyone, not only crew or petroleum workers.
- The petroleum company is a pilot deployment, not a separate product.
- A person completes a short check-in, typically in 3–5 minutes.
- The check-in may use:
  - Self-reflection / BAT questions.
  - Camera-derived markers, including blink rate, eye openness, gaze, head position, smile, and pupil-related measurements.
  - Voice sentiment.
- The person sees their individual result, private history, and recovery recommendations.
- Raw camera/video and microphone/audio recordings are not retained.
- Derived marker measurements and sentiment snapshots are retained in the person’s private history.
- The employer cannot see individual answers, scores, measurements, sentiment, history, or recordings.
- The employer may receive only de-identified, collective department-level trends.
- CIQ is a self-reflection and wellbeing-support tool. It is not a diagnosis, medical assessment, fitness-for-duty clearance, or employment decision tool.
- The AI should direct people to recovery resources curated by CIQ’s neuro and clinical panel.

## Product architecture: one core, configurable deployments

CIQ should be built as a core platform with deployment-level configuration. Do not fork a separate petroleum product.

| CIQ core | Petroleum pilot configuration |
| --- | --- |
| Privacy model and consent flow | Pilot branding and language |
| Guided check-in flow | BAT/full-assessment question set |
| Camera/voice marker capture | Cadence around shifts or tours, if appropriate |
| Personal results and history | Petroleum-specific recovery resources and support contacts |
| Curated resource matching | Tenant/SSO and department aggregate reporting |
| Data-access boundaries | Separately versioned and validated scoring profile |

Every assessment must record the assessment-profile version used to create it. A context-specific scoring model should not be silently treated as universally applicable.

## Safety and trust principles

1. The user is the primary audience.
   - Individual check-ins are presented as personal reflections, not as an employer programme or a performance tool.

2. Consent comes before browser permissions.
   - Explain why camera and microphone are needed, what is measured, what is retained, and who can see the output before triggering the browser permission prompt.

3. Make the privacy boundary unmistakable.
   - Use direct language: “Only you can see your individual result.”
   - Also say: “Your employer sees anonymous, combined department trends only.”

4. Avoid diagnostic or clearance language.
   - Avoid: “Fit,” “pre-tour readiness,” “clearance,” “passed,” “failed,” or statements implying a clinical conclusion.
   - Prefer: “Private wellbeing check-in,” “today’s snapshot,” “reflection,” “recovery,” and “next step.”

5. Explain uncertainty.
   - Results should state that a snapshot can vary with sleep, environment, workload, and many other factors.
   - Marker data provides context; it does not define a person or diagnose a condition.

6. End with a useful action.
   - The primary outcome is a curated recovery resource or support route, not a technical dashboard or a raw score.

7. Let detail be available without being forced on the user.
   - Use progressive disclosure for biometric details, scoring explanations, and privacy detail.

## Recommended user journey

### 1. Home: calm invitation

The home screen should have one job: let a person begin a private check-in.

Suggested content:

- Headline: “How are you feeling today?”
- Supporting line: “Take a few quiet minutes to check in with yourself and choose a recovery step that feels useful.”
- Primary action: “Start check-in”
- Time expectation: “About 3–5 minutes”
- Three compact trust signals:
  - Private to you.
  - Raw audio and video not saved.
  - Employer sees anonymous trends only.

Do not show raw biometrics, extensive privacy copy, a full report, or product-admin navigation on this screen.

### 2. Just-in-time consent and setup

After the person elects to start, explain the permission request in plain language.

The consent should confirm:

- CIQ uses camera/voice session patterns and self-reflection answers.
- Raw audio and video are not retained.
- Marker measurements and a sentiment snapshot are saved in the person’s private history.
- The check-in is not a diagnosis or a work-clearance decision.
- The person can pause or stop at any time.

Only then ask the browser for camera and microphone permission. Avoid exposing the technical deployment URL as the first piece of information a user receives about camera/microphone access.

Technical marker detail should be available through an expandable disclosure such as “What does CIQ use during a check-in?” rather than as the dominant screen content.

### 3. Check-in

- Present one short question at a time.
- Use clear progress feedback.
- Keep camera/microphone state visible but quiet: “Camera and microphone are on.”
- Repeat the important assurance: “Raw camera and microphone data are not being saved.”
- Give the person an obvious “Stop check-in” control.
- Avoid showing live pupil, gaze, or blink values while the person is trying to answer honestly.

### 4. Private snapshot

The result should lead with a supportive, non-diagnostic reflection, not an uncontextualised numeric score.

Example framing:

> Today looks like a good time to make recovery a priority.
>
> Your answers and session patterns suggest you may be carrying more load than usual. This is a prompt to pause and support yourself—not a diagnosis or judgement.

Make the private boundary visible but compact:

> Only you can see this individual result.

### 5. Recovery plan

Surface one recommended, curated next action as the primary action. Examples include:

- A short guided reset.
- A recovery routine guide.
- A confidential support-professional route.

The AI may explain why a resource is relevant, but resources should come from the CIQ neuro and clinical panel. The AI must not invent clinical guidance or present itself as a replacement for a professional.

Secondary actions can include “Explore more recovery options” and “View my previous check-ins.”

### 6. Personal history

History belongs to the individual and should be described that way:

> Your check-ins, visible only to you.

Show trends in human language such as “Recovery steady” or “Extra load noticed,” rather than leading with technical markers. Explain that history includes retained marker/sentiment snapshots but not raw recordings.

## Employer aggregate reporting

The petroleum deployment may provide aggregate departmental insights, but this must remain completely separate from an individual’s experience and history.

Individual pages should never imply that a manager can inspect an individual outcome.

Recommended aggregate-report safeguards to define before pilot launch:

- Minimum cohort size before any department trend appears.
- Suppression of small-group, time-window, or filter combinations that could reveal an individual indirectly.
- No drill-down from department trends to a person, shift, check-in, or raw marker.
- Clear role-based access and audit logging for aggregate dashboards.
- Plain-language explanation of exactly what department viewers can and cannot see.

## Current UI issues to avoid

The reviewed screens had a strong visual foundation, but their language and hierarchy made the product look more technical and operational than user-first.

- “Pre-tour readiness” frames the experience as an operational gate.
- “Fit” and “Low/Moderate Risk” can be read as clearance or employment classification.
- The live “Biometrics & Sentiment” dashboard foregrounds measurements a person cannot interpret or act on.
- Browser camera/microphone prompts arrive without meaningful context.
- Detailed technical metrics appear before the user’s own reflection and recovery action.
- AI reports make claims that should be softened, contextualised, and linked to a helpful action.
- Full navigation, configuration labels such as `TEST`, `BATFULL`, `PILOT`, and `CBTFULL`, and prototype controls should not appear in the end-user flow.

`BATFULL` is understood as the full BAT/Burnout Assessment Tool assessment. `TEST` is a test assessment. Any assessment profile should be named in user-friendly language in the end-user interface.

## Visual and content direction

- Keep the existing calm dark visual language if desired, but use space and hierarchy to reduce cognitive load.
- Use one primary action per screen.
- Keep detailed explanation behind “How this works” disclosures.
- Use direct, warm, non-clinical language.
- Avoid presenting biometrics as authoritative facts about emotion, resilience, or work performance.
- Prefer “what may help today” over prescriptive or overly confident conclusions.
- Use accessible contrast, keyboard focus states, readable type, and reduced-motion support.

## Mockup

The interactive HTML mockup is available at:

- [user-first-voice-assistant-mockup.html](./user-first-voice-assistant-mockup.html)

It demonstrates the simplified flow:

1. Home invitation and compact trust signals.
2. Just-in-time setup and consent.
3. One-question-at-a-time check-in.
4. A private, non-diagnostic result.
5. One curated recovery action.
6. Private history.

## Open implementation decisions

1. Retention: define how long private marker and sentiment history is kept.
2. User control: confirm whether users will eventually be able to export or delete their retained derived data.
3. Aggregate reporting: define cohort thresholds and anti-re-identification rules.
4. Resource triage: define the curated escalation path for people who need urgent or professional support, including country/tenant-specific support contacts.
5. Validation: document the intended use, limitations, and validation status of every assessment/scoring profile before presenting a result as a risk level.

