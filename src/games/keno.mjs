import { click, clickUntilEnabled } from "./steps.mjs";

export const steps = [
  clickUntilEnabled('button:has-text("Auto Pick")', ".bet-button"),
  click(".bet-button"),
];
