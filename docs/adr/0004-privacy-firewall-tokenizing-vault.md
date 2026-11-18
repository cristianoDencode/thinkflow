# 0004. Privacy firewall with a tokenizing vault

## Status

Accepted

## Context

Analysts work with data that contains personal information (tax ids, names, contacts), and send
text to third-party model providers, some of them free tiers with unclear retention. Asking users
to remember to redact is not reliable, and plain redaction breaks the model's ability to reason
about repeated values and to produce an answer the user can act on.

## Decision

A **privacy firewall** (`contexts/privacy`) is applied by the router to every request before it
reaches a provider:

- Native detectors (CPF, CNPJ with check digits, CNS, PIS, voter id, CNH, RENAVAM, cards, e-mail,
  phone, CEP, RG, plates, names from a first-name list) run on every text part of the request.
  An optional **Presidio** sidecar adds names and addresses in free text; if it fails or is slow,
  the call continues with the native detectors only.
- Each detected value is replaced by a **reversible token** such as `[CPF_1]`. The same value maps
  to the same token inside a scope (conversation, report, request).
- The mapping is kept in a **vault** in SQLite, with values encrypted (AES-256-GCM) and indexed by
  a keyed hash. The answer, including streams, is **restored** before it reaches the user. The vault
  is deleted with its conversation or report.
- Data with AI adds per-column rules (reveal, tokenize, omit) and structure-only or masked-sample
  visibility; prototype captures are scrubbed of typed values and grid rows.
- It is on by default and also covers local models.

## Consequences

- Providers see codes, not identifiers, and users see normal answers.
- Detection is heuristic and text-only: images and PDFs are not filtered, and unusual formats can
  slip through, so the guarantee is a mitigation, not a proof.
- Tokenizing costs a little context and some CPU per request, and models can occasionally mangle a
  token, which then cannot be restored.
- Values live encrypted in the database for the life of the conversation, so the secret must be
  protected like any other credential.
