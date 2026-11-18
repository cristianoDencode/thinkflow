import type { TestBBox, TestLocator } from '@thinkflow/shared';

/**
 * What the script injected in the recorded pages reports about an element. Locator candidates
 * come with how many elements of the page they match (computed in the page, right when the user
 * acts, before a navigation can remove the element).
 */
export interface ElementFacts {
  tag: string;
  /** `input` type (text, email, password, checkbox…). */
  inputType: string | null;
  /** ARIA role (explicit or implicit), when the element has one Playwright's getByRole knows. */
  role: string | null;
  /** Approximation of the accessible name. */
  name: string;
  /** Visible label (`<label>`, aria-label, placeholder…) used for people and parameter names. */
  label: string;
  /** `name` attribute of form fields (parameter name fallback). */
  fieldName: string | null;
  candidates: { locator: TestLocator; count: number }[];
  /** Password, card number, one-time code… never shown in documents or screenshots. */
  secret: boolean;
  bbox: TestBBox | null;
  frameUrl: string | null;
}

export type RecorderEvent =
  | { type: 'click'; facts: ElementFacts; at: number }
  | { type: 'dblclick'; facts: ElementFacts; at: number }
  | { type: 'fill'; facts: ElementFacts; value: string; at: number }
  /** `value` is the label of the chosen option. */
  | { type: 'select'; facts: ElementFacts; value: string; at: number }
  | { type: 'check' | 'uncheck'; facts: ElementFacts; at: number }
  | { type: 'press'; facts: ElementFacts | null; key: string; at: number }
  /** A navigation that no recorded action caused (address bar, back/forward). */
  | { type: 'navigate'; url: string; at: number };

/** Page where an event happened. */
export interface EventPage {
  url: string;
  title: string;
}
